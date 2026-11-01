-- EXAMPLE DATA ONLY: edit these courses before going live.
-- All sample sessions are generated relative to the day you execute this file.
-- Times here are UTC and shown in Europe/Berlin on the demo site.
INSERT INTO courses (title, description, category, duration_minutes, capacity, price_cents)
VALUES
('Morning Hatha Flow', 'Mindful movement, breathwork and grounded poses. All levels welcome.', 'Gentle', 70, 10, 1500),
('Vinyasa & Energy', 'A dynamic, energizing flow that builds strength and focus.', 'Dynamic', 60, 12, 1800),
('Yin & Deep Rest', 'Slow restorative stretches, quiet breathing and complete release.', 'Restorative', 75, 8, 1400);

-- Generates example weekly classes for the next eight weeks.
WITH RECURSIVE days(d) AS (
 SELECT date('now', '+1 day')
 UNION ALL SELECT date(d, '+1 day') FROM days WHERE d < date('now', '+55 days')
)
INSERT OR IGNORE INTO sessions (course_id, starts_at, ends_at)
SELECT 1, d || 'T07:00:00Z', d || 'T08:10:00Z' FROM days WHERE strftime('%w', d) = '2';
WITH RECURSIVE days(d) AS (
 SELECT date('now', '+1 day')
 UNION ALL SELECT date(d, '+1 day') FROM days WHERE d < date('now', '+55 days')
)
INSERT OR IGNORE INTO sessions (course_id, starts_at, ends_at)
SELECT 2, d || 'T16:00:00Z', d || 'T17:00:00Z' FROM days WHERE strftime('%w', d) = '4';
WITH RECURSIVE days(d) AS (
 SELECT date('now', '+1 day')
 UNION ALL SELECT date(d, '+1 day') FROM days WHERE d < date('now', '+55 days')
)
INSERT OR IGNORE INTO sessions (course_id, starts_at, ends_at)
SELECT 3, d || 'T09:00:00Z', d || 'T10:15:00Z' FROM days WHERE strftime('%w', d) = '6';
