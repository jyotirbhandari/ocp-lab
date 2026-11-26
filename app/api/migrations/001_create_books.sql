CREATE TABLE books (
  id     SERIAL PRIMARY KEY,
  title  TEXT NOT NULL,
  author TEXT NOT NULL,
  price  NUMERIC(8,2) NOT NULL
);
