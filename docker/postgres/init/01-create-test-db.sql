-- Runs once, when the Postgres volume is first created.
-- A separate database for automated tests so they never touch dev data.
CREATE DATABASE padelloyalty_test OWNER padel;
