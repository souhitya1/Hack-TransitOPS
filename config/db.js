
const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host:  'localhost',
    user:  'root',
    password: process.env.SQL_PASSWORD || '',
    database:  'transitops',
    waitForConnections: true,
    connectionLimit: 10
});

async function testConnection() {
    try {
        const [rows] = await pool.query('SELECT 1 + 1 AS result');
        console.log('Database connected. Test query result:', rows[0].result);
    } catch (err) {
        console.error('Database connection failed:', err.message);
    }
}

module.exports = { pool, testConnection };