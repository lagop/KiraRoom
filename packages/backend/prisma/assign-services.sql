-- Assign services to professionals based on their position/specialty
-- This script assigns random services to professionals who don't have any

-- First, let's see what professionals exist and their current assignments
SELECT
    p.id,
    p.first_name,
    p.last_name,
    p.position,
    COALESCE(
        (SELECT json_agg(s.name) FROM "ProfessionalService" ps JOIN "services" s ON ps.service_id = s.id WHERE ps.professional_id = p.id),
        '[]'::json
    ) as assigned_services
FROM "professionals" p;

-- Get all service IDs by category
-- Hair services
SELECT id, name FROM "services" WHERE category = 'hair';
-- Nail services
SELECT id, name FROM "services" WHERE category = 'nails';
-- Facial services
SELECT id, name FROM "services" WHERE category = 'facial';
-- Massage services
SELECT id, name FROM "services" WHERE category = 'massage';
