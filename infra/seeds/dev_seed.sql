-- QueueBridge — Development Seed Data
-- Creates: 1 org, 1 facility, 2 services, 2 counters, 1 staff user with all roles
-- Idempotent: uses INSERT ... ON CONFLICT DO NOTHING throughout

-- ---------------------------------------------------------------------------
-- Organization
-- ---------------------------------------------------------------------------

INSERT INTO organizations (id, name, slug)
VALUES (
  '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b',
  'Demo Health Centre',
  'demo-health-centre'
)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Facility
-- ---------------------------------------------------------------------------

INSERT INTO facilities (id, organization_id, name, slug, timezone, status)
VALUES (
  '018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b',
  '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b',
  'Main Reception',
  'main-reception',
  'Africa/Lagos',
  'active'
)
ON CONFLICT (organization_id, slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Services
-- ---------------------------------------------------------------------------

INSERT INTO services (id, facility_id, organization_id, name, description, policy)
VALUES
  (
    '018d1a2b-3c4d-7e5f-8a9b-2c3d4e5f6a7b',
    '018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b',
    '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b',
    'General Consultation',
    'General outpatient consultation',
    '{"version": "v1", "priority_order": ["urgent", "priority", "normal"], "grace_window_seconds": 300}'
  ),
  (
    '018d1a2b-3c4d-7e5f-8a9b-3c4d5e6f7a8b',
    '018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b',
    '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b',
    'Registration',
    'Patient registration and records',
    '{"version": "v1", "priority_order": ["urgent", "normal"], "grace_window_seconds": 180}'
  )
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Counters
-- ---------------------------------------------------------------------------

INSERT INTO counters (id, facility_id, organization_id, name, active)
VALUES
  (
    '018d1a2b-3c4d-7e5f-8a9b-4c5d6e7f8a9b',
    '018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b',
    '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b',
    'Counter 1',
    TRUE
  ),
  (
    '018d1a2b-3c4d-7e5f-8a9b-5c6d7e8f9a0b',
    '018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b',
    '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b',
    'Counter 2',
    TRUE
  )
ON CONFLICT DO NOTHING;

-- Counter capabilities: both counters serve General Consultation; Counter 1 also serves Registration
INSERT INTO counter_service_capabilities (counter_id, service_id)
VALUES
  ('018d1a2b-3c4d-7e5f-8a9b-4c5d6e7f8a9b', '018d1a2b-3c4d-7e5f-8a9b-2c3d4e5f6a7b'),
  ('018d1a2b-3c4d-7e5f-8a9b-4c5d6e7f8a9b', '018d1a2b-3c4d-7e5f-8a9b-3c4d5e6f7a8b'),
  ('018d1a2b-3c4d-7e5f-8a9b-5c6d7e8f9a0b', '018d1a2b-3c4d-7e5f-8a9b-2c3d4e5f6a7b')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Staff user (password: dev-password — bcrypt hash below is for testing only)
-- In production: NEVER commit real password hashes or use this test user
-- ---------------------------------------------------------------------------

INSERT INTO staff_users (id, organization_id, email, password_hash, display_name, status)
VALUES (
  '018d1a2b-3c4d-7e5f-8a9b-6c7d8e9f0a1b',
  '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b',
  'admin@demo.local',
  -- bcrypt hash of 'dev-only-not-for-production' at cost 12 — DO NOT USE IN PRODUCTION
  '$2b$12$placeholder_hash_replace_with_real_hash_before_use',
  'Demo Admin',
  'active'
)
ON CONFLICT (organization_id, email) DO NOTHING;

-- Grant all roles to the demo staff user for development convenience
INSERT INTO role_assignments (id, staff_user_id, facility_id, role)
VALUES
  ('018d1a2b-3c4d-7e5f-8a9b-7c8d9e0f1a2b', '018d1a2b-3c4d-7e5f-8a9b-6c7d8e9f0a1b', '018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b', 'facility_admin'),
  ('018d1a2b-3c4d-7e5f-8a9b-8c9d0e1f2a3b', '018d1a2b-3c4d-7e5f-8a9b-6c7d8e9f0a1b', '018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b', 'supervisor'),
  ('018d1a2b-3c4d-7e5f-8a9b-9c0d1e2f3a4b', '018d1a2b-3c4d-7e5f-8a9b-6c7d8e9f0a1b', '018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b', 'staff_counter'),
  ('018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5c', '018d1a2b-3c4d-7e5f-8a9b-6c7d8e9f0a1b', '018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b', 'auditor')
ON CONFLICT (staff_user_id, facility_id, role) DO NOTHING;
