-- Data sources, using the keys and freshness limits in backend/weather-data.mjs
-- (DATA_ENDPOINTS, FRESHNESS_LIMITS_MS) and the cadences in docs/data-sources.md.
INSERT INTO data_sources (code, name, endpoint, published_cadence, freshness_limit, used_for) VALUES
 ('forecast',    'NEA 2-hour weather forecast',
  'https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast',            'every 30 minutes', '60 minutes',
  'Routine score: forecast component'),
 ('rainfall',    'NEA rainfall across Singapore',
  'https://api-open.data.gov.sg/v2/real-time/api/rainfall',                   'every 5 minutes',  '15 minutes',
  'Routine score: nearest-station 5-minute rainfall'),
 ('lightning',   'NEA lightning observation',
  'https://api-open.data.gov.sg/v2/real-time/api/weather?api=lightning',      '2-minute display; ad-hoc', '5 minutes',
  'Context only - not an official warning or all-clear'),
 ('airQuality',  'NEA Pollutant Standards Index (24-hour PSI)',
  'https://api-open.data.gov.sg/v2/real-time/api/psi',                        'latest regional reading', '90 minutes',
  'Separate air-quality advisory'),
 ('forecast24h', 'NEA 24-hour weather forecast (planned)',
  'https://api-open.data.gov.sg/v2/real-time/api/twenty-four-hr-forecast',    'every 6 hours',    '13 hours',
  'Same-day planning (not yet used by the app)'),
 ('forecast4day','NEA 4-day weather forecast (planned)',
  'https://api-open.data.gov.sg/v2/real-time/api/four-day-outlook',           'every 12 hours',   '26 hours',
  'Advance contingency planning (not yet used by the app)');
