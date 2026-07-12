# TransitOps — Smart Transport Operations Platform

TransitOps is a centralized fleet and transport management platform built for logistics organizations to manage vehicles, drivers, trips, maintenance, and fuel/expenses — replacing spreadsheets and manual logbooks with a system that enforces business rules automatically.

Built for the Odoo Hackathon (8-hour build).

## Problem It Solves

Logistics teams relying on manual tracking run into scheduling conflicts, underused vehicles, missed maintenance, expired driver licenses, inaccurate expense tracking, and poor visibility into operations. TransitOps digitizes the full lifecycle — from registering a vehicle to dispatching a trip to logging fuel costs — while automatically enforcing the rules that prevent these problems.

## Tech Stack

- **Backend:** Node.js, Express
- **Frontend:** EJS (server-rendered views), Bootstrap
- **Database:** MySQL

## Target Users

| Role | What they do |
|---|---|
| Fleet Manager | Oversees vehicles, maintenance, and overall fleet efficiency |
| Driver | Creates trips, assigns vehicles/drivers, monitors deliveries |
| Safety Officer | Tracks driver license validity and safety scores |
| Financial Analyst | Reviews fuel costs, maintenance costs, and profitability |

## Core Features

- **Dashboard** — live KPIs: active/available vehicles, vehicles in maintenance, active/pending trips, drivers on duty, fleet utilization %, with filters by vehicle type, status, and region
- **Vehicle Registry** — register and manage vehicles (registration number, type, capacity, odometer, acquisition cost, status)
- **Driver Management** — register and manage drivers (license number, category, expiry date, safety score, status)
- **Trip Management** — create trips with a full lifecycle: Draft → Dispatched → Completed → Cancelled
- **Maintenance** — log maintenance records; a vehicle is automatically pulled out of dispatch while an active record exists
- **Fuel & Expense Tracking** — log fuel and other costs, with automatic operational cost calculation per vehicle
- **Ask TransitOps (AI Search)** — a Gemini-powered natural language search bar where drivers and fleet managers can ask questions like *"how many trips are available"* or *"any vehicles in the shop"* and get a plain-language answer, grounded in live fleet data pulled straight from the database

## Business Rules Enforced Automatically

- Vehicle registration numbers must be unique
- Retired or in-shop vehicles never appear as dispatch options
- Drivers with expired licenses or suspended status cannot be assigned to trips
- A vehicle or driver already on a trip cannot be assigned to another
- Cargo weight cannot exceed a vehicle's maximum load capacity
- Dispatching a trip sets both vehicle and driver status to *On Trip*
- Completing a trip sets both back to *Available*
- Cancelling a dispatched trip restores both to *Available*
- Creating a maintenance record sets the vehicle to *In Shop*
- Closing a maintenance record restores the vehicle to *Available* (unless retired)


## AI Search — "Ask TransitOps"

A natural language search feature powered by the Gemini API, available to any logged-in user via the **Ask TransitOps** link in the navbar.

**How it works:**
1. The user types a question in plain English (e.g. *"how many trips are available"*, *"how many drivers are free right now"*, *"any vehicles in the shop"*)
2. The backend pulls live counts from the database — vehicles by status, drivers by status, trips by status
3. That data is packaged as compact JSON and sent to Gemini (`gemini-flash-latest`) along with the user's question, with instructions to answer only from the given data
4. Gemini returns a short, plain-language answer grounded in real, current fleet data — no manual filtering or searching through tables required

This replaces manually clicking through vehicle/driver/trip tables to count or filter records — the answer is generated instantly from a single question.

## Setup

**1. Clone and install dependencies**
```
git clone https://github.com/souhitya1/Hack-TransitOPS.git
cd Hack-TransitOPS
npm install
```

**2. Configure environment variables**

Create a `.env` file in the project root:
```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=transitops
PORT=8080
GEMINI_API_KEY=your_gemini_api_key
```

Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/) if you don't have one — needed for the "Ask TransitOps" AI search feature.

**3. Set up the database**

Using the MySQL CLI:
```
mysql -u root -p
SOURCE database/schema.sql;
SOURCE database/seed.sql;
```
Or use `database/init.js` to create and seed the database directly from Node:
```
node database/init.js
```

**4. Verify the database connection**
```
node database/test-connection.js
```

**5. Run the app**
```
node app.js
```
Visit `http://localhost:8080`.

## Database Entities

Users · Vehicles · Drivers · Trips · Maintenance Logs · Fuel Logs · Expenses

## Roadmap

- Authentication with role-based access control
- Full CRUD screens for Trips, Maintenance, Fuel & Expenses, Reports
- Email reminders for expiring licenses
- Search, filters, and sorting across list views
