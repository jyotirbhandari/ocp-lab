const { Pool } = require('pg');
const { MongoClient } = require('mongodb');

const pg = new Pool(); // reads PG* env vars

const mongoUrl =
  `mongodb://${encodeURIComponent(process.env.MONGO_USER)}:` +
  `${encodeURIComponent(process.env.MONGO_PASSWORD)}@` +
  `${process.env.MONGO_HOST || 'mongo'}:27017/` +
  `${process.env.MONGO_DB || 'bookstore'}?authSource=admin`;

const mongo = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 3000 });

module.exports = { pg, mongo };


