const express = require("express");
const app = express();
const port = 8080;
const path = require("path");
const { pool } = require("./config/db");
const ejsmate = require("ejs-mate");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { GoogleGenAI } = require("@google/genai");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "/views"));
app.use(express.static(path.join(__dirname, "public")));
app.engine('ejs', ejsmate);
app.use(express.urlencoded({ extended: true }));
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY' });
app.use(session({
  secret: 'transitops-secure-fleet-key', 
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 2 } 
}));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/TransitOPS/login?error=" + encodeURIComponent("Please sign in to access the network."));
  }
  next();
}

function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.session.user || !allowedRoles.includes(req.session.user.role)) {
      return res.status(403).send("Access Denied: Your profile role lacks permissions to access this terminal action.");
    }
    next();
  }
}


app.get("/TransitOPS/signup", (req, res) => {
  res.render("auth/signup.ejs", { error: req.query.error || null });
});

app.post("/TransitOPS/signup", async (req, res) => {
  const { email, password, role } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 12);
    
    await pool.query(
      "INSERT INTO users (email, password, role) VALUES (?, ?, ?)",
      [email, hashedPassword, role]
    );
    res.redirect("/TransitOPS/login");
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.redirect("/TransitOPS/signup?error=" + encodeURIComponent("An account with that email already exists."));
    }
    res.status(500).send("Error compiling registry access key.");
  }
});

app.get("/TransitOPS/login", (req, res) => {
  res.render("auth/login.ejs", { error: req.query.error || null });
});

app.post("/TransitOPS/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    if (rows.length === 0) {
      return res.redirect("/TransitOPS/login?error=" + encodeURIComponent("Invalid registry email profile lookup."));
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    
    if (!isMatch) {
      return res.redirect("/TransitOPS/login?error=" + encodeURIComponent("Incorrect credential matrix sequence."));
    }

    req.session.user = { id: user.id, email: user.email, role: user.role };
    res.redirect("/TransitOPS");
  } catch (err) {
    res.status(500).send("Auth Engine validation failure.");
  }
});

app.get("/TransitOPS/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/TransitOPS/login");
  });
});

app.get("/TransitOPS", requireAuth, async (req, res) => {
  try {
    const [vehicles] = await pool.query("SELECT * FROM vehicles ORDER BY created_at DESC LIMIT 5");
    const [[{ v_count }]] = await pool.query("SELECT COUNT(*) AS v_count FROM vehicles WHERE status = 'Available'");
    const [[{ d_count }]] = await pool.query("SELECT COUNT(*) AS d_count FROM drivers WHERE status = 'Available' AND license_expiry_date >= CURDATE()");
    const [[{ t_count }]] = await pool.query("SELECT COUNT(*) AS t_count FROM trips WHERE status = 'Dispatched'");

    res.render("home.ejs", { 
      vehicles, 
      metrics: { availableVehicles: v_count, availableDrivers: d_count, activeTrips: t_count } 
    });
  } catch (err) {
    console.error("Dashboard Engine Error:", err);
    res.status(500).send("Database Error loading Dashboard Hub");
  }
});

// --- AI Search (Gemini) ---
app.get("/TransitOPS/search", requireAuth, async (req, res) => {
  res.render("search/index.ejs", { question: null, answer: null, error: null });
});

app.post("/TransitOPS/search", requireAuth, async (req, res) => {
  const { question } = req.body;
  try {
    // Pull a compact summary of current fleet data to give Gemini real context
    const [[{ available_vehicles }]] = await pool.query("SELECT COUNT(*) AS available_vehicles FROM vehicles WHERE status = 'Available'");
    const [[{ on_trip_vehicles }]] = await pool.query("SELECT COUNT(*) AS on_trip_vehicles FROM vehicles WHERE status = 'On Trip'");
    const [[{ in_shop_vehicles }]] = await pool.query("SELECT COUNT(*) AS in_shop_vehicles FROM vehicles WHERE status = 'In Shop'");
    const [[{ retired_vehicles }]] = await pool.query("SELECT COUNT(*) AS retired_vehicles FROM vehicles WHERE status = 'Retired'");

    const [[{ available_drivers }]] = await pool.query("SELECT COUNT(*) AS available_drivers FROM drivers WHERE status = 'Available' AND license_expiry_date >= CURDATE()");
    const [[{ on_trip_drivers }]] = await pool.query("SELECT COUNT(*) AS on_trip_drivers FROM drivers WHERE status = 'On Trip'");
    const [[{ suspended_drivers }]] = await pool.query("SELECT COUNT(*) AS suspended_drivers FROM drivers WHERE status = 'Suspended'");

    const [[{ draft_trips }]] = await pool.query("SELECT COUNT(*) AS draft_trips FROM trips WHERE status = 'Draft'");
    const [[{ dispatched_trips }]] = await pool.query("SELECT COUNT(*) AS dispatched_trips FROM trips WHERE status = 'Dispatched'");
    const [[{ completed_trips }]] = await pool.query("SELECT COUNT(*) AS completed_trips FROM trips WHERE status = 'Completed'");
    const [[{ cancelled_trips }]] = await pool.query("SELECT COUNT(*) AS cancelled_trips FROM trips WHERE status = 'Cancelled'");

    const fleetSummary = {
      vehicles: { available_vehicles, on_trip_vehicles, in_shop_vehicles, retired_vehicles },
      drivers: { available_drivers, on_trip_drivers, suspended_drivers },
      trips: { draft_trips, dispatched_trips, completed_trips, cancelled_trips }
    };

    const prompt = `You are a fleet operations assistant for a logistics platform called TransitOps.
Answer the user's question using ONLY the data below. Be concise (1-2 sentences), factual, and speak in plain language rather than repeating raw field names.
If the data doesn't contain what's needed to answer, say so clearly instead of guessing.

Fleet data (JSON):
${JSON.stringify(fleetSummary)}

Question: ${question}`;

    const result = await ai.models.generateContent({
      model: "gemini-flash-latest",
      contents: prompt
    });

    const answer = result.text;

    res.render("search/index.ejs", { question, answer, error: null });
  } catch (err) {
    console.error("AI Search Error:", err);
    res.render("search/index.ejs", { question, answer: null, error: "Couldn't get an answer right now. Please try again." });
  }
});


app.get("/TransitOPS/vehicles", requireAuth, async (req, res) => {
  try {
    const [vehicles] = await pool.query("SELECT * FROM vehicles");
    res.render("index.ejs", { vehicles });
  } catch (err) {
    console.error(err);
    res.status(500).send("Database Error");
  }
});

app.get("/TransitOPS/vehicles/new", requireAuth, (req, res) => {
  res.render("vehicles/new.ejs", { error: null });
});

app.post("/TransitOPS/vehicles", requireAuth, async (req, res) => {
  const { registration_number, model_name, type, max_load_capacity, odometer, acquisition_cost, status, region } = req.body;
  try {
    await pool.query(
      `INSERT INTO vehicles(registration_number, model_name, type, max_load_capacity, odometer, acquisition_cost, status, region)
       VALUES(?,?,?,?,?,?,?,?)`,
      [registration_number, model_name, type, max_load_capacity, odometer || 0, acquisition_cost || 0, status || 'Available', region || null]
    );
    res.redirect("/TransitOPS");
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return res.render("vehicles/new.ejs", {
        error: `The registration number '${registration_number}' is already assigned to a fleet vehicle.`
      });
    }
    console.error("Insert Error:", err);
    res.status(500).send("Error saving vehicle to registry.");
  }
});

app.get("/TransitOPS/vehicles/:id/edit", requireAuth, async (req, res) => {
  let { id } = req.params;
  try {
    const [rows] = await pool.query(`SELECT * FROM vehicles WHERE id= ?`, [id]);
    if (rows.length === 0) {
      return res.status(404).send("Vehicle not found");
    }
    res.render("vehicles/edit.ejs", { vehicle: rows[0], error: null });
  } catch (err) {
    console.error(err);
    res.status(500).send("Database Error");
  }
});

app.post("/TransitOPS/vehicles/:id", requireAuth, async (req, res) => {
  let { id } = req.params;
  const { registration_number, model_name, type, max_load_capacity, odometer, acquisition_cost, status, region } = req.body;
  try {
    await pool.query(
      `UPDATE vehicles 
       SET registration_number = ?, model_name = ?, type = ?, max_load_capacity = ?, odometer = ?, acquisition_cost = ?, status = ?, region = ?
       WHERE id = ?`,
      [registration_number, model_name, type, max_load_capacity, odometer, acquisition_cost, status, region, id]
    );
    res.redirect("/TransitOPS");
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return res.render("vehicles/edit.ejs", {
        vehicle: { id, registration_number, model_name, type, max_load_capacity, odometer, acquisition_cost, status, region },
        error: `The registration number '${registration_number}' is already taken by another vehicle.`
      });
    }
    console.error("Update Error:", err);
    res.status(500).send("Error updating vehicle details.");
  }
});

// --- Drivers ---
app.get("/TransitOPS/drivers", requireAuth, async (req, res) => {
  try {
    const [drivers] = await pool.query(`SELECT * FROM drivers ORDER BY created_at DESC`);
    const today = new Date().toISOString().split('T')[0];
    res.render("driver/index.ejs", { drivers, today });
  } catch (err) {
    console.error(err);
    res.status(500).send("Database Error");
  }
});

app.get("/TransitOPS/drivers/new", requireAuth, async (req, res) => {
  res.render("driver/new.ejs", { error: null });
});

app.post("/TransitOPS/drivers", requireAuth, async (req, res) => {
  const { name, license_number, license_category, license_expiry_date, contact_number, safety_score, status } = req.body;
  try {
    await pool.query(
      `INSERT INTO drivers (name, license_number, license_category, license_expiry_date, contact_number, safety_score, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, license_number, license_category, license_expiry_date, contact_number || null, safety_score || 100.00, status || 'Available']
    );
    res.redirect("/TransitOPS/drivers");
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return res.render("driver/new.ejs", {
        error: `License number '${license_number}' is already registered to another driver.`
      });
    }
    console.error(err);
    res.status(500).send("Error saving driver profile.");
  }
});

// --- Trips ---
app.get("/TransitOPS/trips", requireAuth, async (req, res) => {
  try {
    const query = `SELECT t.*, v.registration_number, d.name AS driver_name 
      FROM trips t
      JOIN vehicles v ON t.vehicle_id = v.id
      JOIN drivers d ON t.driver_id = d.id
      ORDER BY t.created_at DESC`;
    const [trips] = await pool.query(query);
    res.render("trips/index.ejs", { trips });
  } catch (err) {
    console.error(err);
    res.status(500).send("Database Error");
  }
});

app.get("/TransitOPS/trips/new", requireAuth, async (req, res) => {
  const { error } = req.query;
  try {
    const [vehicles] = await pool.query(`SELECT id, registration_number, max_load_capacity FROM vehicles WHERE status = 'Available'`);
    const [drivers] = await pool.query(`SELECT id, name FROM drivers WHERE status = 'Available' AND license_expiry_date >= CURDATE()`);
    res.render("trips/new.ejs", { vehicles, drivers, error: error || null });
  } catch (err) {
    console.error(err);
    res.status(500).send("Database Error loading trip creation portal.");
  }
});

app.post("/TransitOPS/trips", requireAuth, async (req, res) => {
  const { source, destination, cargo_weight, planned_distance, vehicle_id, driver_id } = req.body;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [vRows] = await connection.query("SELECT status, max_load_capacity FROM vehicles WHERE id = ? FOR UPDATE", [vehicle_id]);
    if (vRows.length === 0 || vRows[0].status !== 'Available') {
      throw new Error("The selected fleet unit is no longer available.");
    }
    if (parseFloat(cargo_weight) > parseFloat(vRows[0].max_load_capacity)) {
      throw new Error(`Freight load exceeds limits. Vehicle max threshold is ${vRows[0].max_load_capacity} kg.`);
    }
    const [dRows] = await connection.query("SELECT status, license_expiry_date FROM drivers WHERE id = ? FOR UPDATE", [driver_id]);
    if (dRows.length === 0 || dRows[0].status !== 'Available') {
      throw new Error("The chosen driver option is no longer available.");
    }
    if (new Date(dRows[0].license_expiry_date) < new Date()) {
      throw new Error("The assigned operator possesses an expired operating credential.");
    }

    await connection.query(
      `INSERT INTO trips (source, destination, cargo_weight, planned_distance, vehicle_id, driver_id, status) 
       VALUES (?, ?, ?, ?, ?, ?, 'Draft')`,
      [source, destination, cargo_weight, planned_distance || null, vehicle_id, driver_id]
    );
    await connection.query("UPDATE vehicles SET status = 'On Trip' WHERE id = ?", [vehicle_id]);
    await connection.query("UPDATE drivers SET status = 'On Trip' WHERE id = ?", [driver_id]);

    await connection.commit();
    res.redirect("/TransitOPS/trips");
  } catch (err) {
    await connection.rollback();
    res.redirect(`/TransitOPS/trips/new?error=${encodeURIComponent(err.message)}`);
  } finally {
    connection.release();
  }
});

app.post("/TransitOPS/trips/:id/status", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { action, final_odometer, fuel_consumed } = req.body;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [trip] = await connection.query("SELECT * FROM trips WHERE id = ?", [id]);
    if (trip.length === 0) throw new Error("Target allocation matrix record missing.");
    
    const { vehicle_id, driver_id } = trip[0];

    if (action === 'DISPATCH') {
      await connection.query("UPDATE trips SET status = 'Dispatched', dispatched_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    } 
    else if (action === 'CANCEL') {
      await connection.query("UPDATE trips SET status = 'Cancelled' WHERE id = ?", [id]);
      await connection.query("UPDATE vehicles SET status = 'Available' WHERE id = ?", [vehicle_id]);
      await connection.query("UPDATE drivers SET status = 'Available' WHERE id = ?", [driver_id]);
    } 
    else if (action === 'COMPLETE') {
      await connection.query(
        `UPDATE trips SET status = 'Completed', completed_at = CURRENT_TIMESTAMP, final_odometer = ?, fuel_consumed = ? WHERE id = ?`, 
        [final_odometer || null, fuel_consumed || null, id]
      );
      await connection.query("UPDATE vehicles SET status = 'Available' WHERE id = ?", [vehicle_id]);
      await connection.query("UPDATE drivers SET status = 'Available' WHERE id = ?", [driver_id]);
      if (final_odometer) {
         await connection.query("UPDATE vehicles SET odometer = ? WHERE id = ?", [final_odometer, vehicle_id]);
      }
    }
    await connection.commit();
    res.redirect("/TransitOPS/trips");
  } catch (err) {
    await connection.rollback();
    res.status(500).send("Trip transition failed.");
  } finally {
    connection.release();
  }
});

// --- Maintenance ---
app.get("/TransitOPS/maintenance", requireAuth, async (req, res) => {
   try {
    const query = `SELECT m.*, v.registration_number, v.model_name 
      FROM maintenance_records m
      JOIN vehicles v ON m.vehicle_id = v.id
      ORDER BY m.status DESC, m.logged_at DESC`;
    const [records] = await pool.query(query);
    res.render("maintenance/index.ejs", { records });
  } catch (err) {
    console.error(err);
    res.status(500).send("Database Error loading maintenance logs.");
  }
});

app.get("/TransitOPS/maintenance/new", requireAuth, async (req, res) => {
  try {
    const [vehicles] = await pool.query("SELECT id, registration_number FROM vehicles WHERE status NOT IN ('In Shop', 'Retired')");
    res.render("maintenance/new.ejs", { vehicles });
  } catch (err) {
    console.error(err);
    res.status(500).send("Database Error loading ticket creation portal.");
  }
});

app.post("/TransitOPS/maintenance", requireAuth, async (req, res) => {
  const { vehicle_id, issue_description } = req.body;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      "INSERT INTO maintenance_records (vehicle_id, issue_description, status) VALUES (?, ?, 'Under Repair')",
      [vehicle_id, issue_description]
    );
    await connection.query("UPDATE vehicles SET status = 'In Shop' WHERE id = ?", [vehicle_id]);

    await connection.commit();
    res.redirect("/TransitOPS/maintenance");
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).send("Failed to create maintenance ticket.");
  } finally {
    connection.release();
  }
});

app.post("/TransitOPS/maintenance/:id/close", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { cost, next_vehicle_status } = req.body; 
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [record] = await connection.query("SELECT vehicle_id FROM maintenance_records WHERE id = ?", [id]);
    if (record.length === 0) throw new Error("Ticket record missing.");
    const vehicleId = record[0].vehicle_id;
    await connection.query(
      "UPDATE maintenance_records SET status = 'Resolved', cost = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?",
      [cost || 0.00, id]
    );
    await connection.query("UPDATE vehicles SET status = ? WHERE id = ?", [next_vehicle_status || 'Available', vehicleId]);

    await connection.commit();
    res.redirect("/TransitOPS/maintenance");
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).send("Failed to close maintenance log.");
  } finally {
    connection.release();
  }
});

// --- Fuel & Expenses (Protected Routes) ---
app.get("/TransitOPS/expenses", requireAuth, async (req, res) => {
  try {
    const [logs] = await pool.query(`
      SELECT e.*, v.registration_number 
      FROM expenses e
      JOIN vehicles v ON e.vehicle_id = v.id
      ORDER BY e.date DESC, e.created_at DESC LIMIT 50
    `);
    const [summary] = await pool.query(`
      SELECT 
        v.id, 
        v.registration_number, 
        v.model_name,
        COALESCE(SUM(e.amount), 0) AS total_cost,
        COALESCE(SUM(CASE WHEN e.type = 'Fuel' THEN e.amount END), 0) AS fuel_cost,
        COALESCE(SUM(CASE WHEN e.type = 'Maintenance' THEN e.amount END), 0) AS maintenance_cost,
        COALESCE(SUM(CASE WHEN e.type NOT IN ('Fuel', 'Maintenance') THEN e.amount END), 0) AS other_costs
      FROM vehicles v
      LEFT JOIN expenses e ON v.id = e.vehicle_id
      GROUP BY v.id, v.registration_number, v.model_name
      ORDER BY total_cost DESC
    `);
    res.render("expenses/index.ejs", { logs, summary });
  } catch (err) {
    console.error(err);
    res.status(500).send("Database Error loading expenses portal.");
  }
});

app.get("/TransitOPS/expenses/new", requireAuth, requireRole(['Admin', 'Dispatcher']), async (req, res) => {
  try {
    const [vehicles] = await pool.query("SELECT id, registration_number FROM vehicles WHERE status != 'Retired'");
    const today = new Date().toISOString().split('T')[0];
    res.render("expenses/new.ejs", { vehicles, today });
  } catch (err) {
    console.error(err);
    res.status(500).send("Database Error loading expense form.");
  }
});

app.post("/TransitOPS/expenses", requireAuth, requireRole(['Admin', 'Dispatcher']), async (req, res) => {
  const { vehicle_id, type, amount, date, description } = req.body;
  try {
    await pool.query(
      `INSERT INTO expenses (vehicle_id, type, amount, date, description) 
       VALUES (?, ?, ?, ?, ?)`,
      [vehicle_id, type, amount, date, description || null]
    );
    res.redirect("/TransitOPS/expenses");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error compiling financial record entry.");
  }
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});