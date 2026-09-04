-- KiraStudio SaaS Database Initialization Script
-- This script initializes the PostgreSQL database for the beauty salon management platform

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create tables for the multi-tenant beauty salon platform
-- Note: Each table includes tenant_id for row-level security

-- Tenants table (Salon/Clinic configuration)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    subdomain VARCHAR(100) UNIQUE,
    settings JSONB DEFAULT '{}',
    subscription_status VARCHAR(50) DEFAULT 'trial',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Users table (System users with roles)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    phone VARCHAR(20),
    role VARCHAR(50) DEFAULT 'client',
    is_active BOOLEAN DEFAULT true,
    email_verified BOOLEAN DEFAULT false,
    last_login_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Clients table (End customers)
CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20),
    date_of_birth DATE,
    gender VARCHAR(20),
    address JSONB DEFAULT '{}',
    preferences JSONB DEFAULT '{}',
    loyalty_points INTEGER DEFAULT 0,
    total_spent DECIMAL(10,2) DEFAULT 0.00,
    last_visit_at TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Professionals table (Salon staff)
CREATE TABLE professionals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20),
    specializations TEXT[],
    hourly_rate DECIMAL(8,2),
    commission_rate DECIMAL(5,2) DEFAULT 0.00,
    schedule JSONB DEFAULT '{}',
    is_available BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Services table (Beauty services offered)
CREATE TABLE services (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    duration_minutes INTEGER NOT NULL,
    price DECIMAL(8,2) NOT NULL,
    color VARCHAR(7) DEFAULT '#3B82F6',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Appointments table (Core booking entity)
CREATE TABLE appointments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
    professional_id UUID REFERENCES professionals(id) ON DELETE CASCADE,
    service_id UUID REFERENCES services(id) ON DELETE CASCADE,
    scheduled_at TIMESTAMP NOT NULL,
    duration_minutes INTEGER NOT NULL,
    status VARCHAR(50) DEFAULT 'scheduled',
    notes TEXT,
    total_amount DECIMAL(8,2),
    payment_status VARCHAR(50) DEFAULT 'pending',
    reminder_sent BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX idx_appointments_tenant_id ON appointments(tenant_id);
CREATE INDEX idx_appointments_client_id ON appointments(client_id);
CREATE INDEX idx_appointments_professional_id ON appointments(professional_id);
CREATE INDEX idx_appointments_scheduled_at ON appointments(scheduled_at);
CREATE INDEX idx_appointments_status ON appointments(status);

CREATE INDEX idx_clients_tenant_id ON clients(tenant_id);
CREATE INDEX idx_professionals_tenant_id ON professionals(tenant_id);
CREATE INDEX idx_services_tenant_id ON services(tenant_id);
CREATE INDEX idx_users_tenant_id ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Add updated_at triggers
CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_clients_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_professionals_updated_at BEFORE UPDATE ON professionals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_services_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_appointments_updated_at BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert sample data for testing
-- Sample tenant (Demo salon)
INSERT INTO tenants (id, name, slug, subdomain, subscription_status) VALUES 
('550e8400-e29b-41d4-a716-446655440000', 'Demo Beauty Salon', 'demo-salon', 'demo', 'active');

-- Sample users
INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name, role) VALUES 
('660e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000', 'admin@demo.com', '$2b$10$rZ3n5GkE5Yl7xJ2nT8sVxeW8X0Y2H1P3Z6L9M4N5O6P7Q8R9S0T1', 'Admin', 'User', 'admin'),
('770e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000', 'client1@example.com', '$2b$10$rZ3n5GkE5Yl7xJ2nT8sVxeW8X0Y2H1P3Z6L9M4N5O6P7Q8R9S0T1', 'Maria', 'Garcia', 'client'),
('880e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000', 'sophia@example.com', '$2b$10$rZ3n5GkE5Yl7xJ2nT8sVxeW8X0Y2H1P3Z6L9M4N5O6P7Q8R9S0T1', 'Sophia', 'Miller', 'professional');

-- Sample clients
INSERT INTO clients (id, tenant_id, user_id, first_name, last_name, email, phone, loyalty_points, total_spent) VALUES 
('990e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000', '770e8400-e29b-41d4-a716-446655440000', 'Maria', 'Garcia', 'client1@example.com', '+1-555-0123', 150, 450.00);

-- Sample professionals
INSERT INTO professionals (id, tenant_id, user_id, first_name, last_name, email, phone, specializations, hourly_rate) VALUES 
('aa0e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000', '880e8400-e29b-41d4-a716-446655440000', 'Sophia', 'Miller', 'sophia@example.com', '+1-555-0124', ARRAY['hair', 'makeup', 'styling'], 75.00);

-- Sample services
INSERT INTO services (id, tenant_id, name, description, category, duration_minutes, price, color) VALUES 
('bb0e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000', 'Hair Cut & Style', 'Professional haircut with styling', 'Hair', 60, 85.00, '#FF6B6B'),
('cc0e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000', 'Manicure', 'Classic manicure with nail polish', 'Nails', 45, 35.00, '#4ECDC4'),
('dd0e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000', 'Facial Treatment', 'Deep cleansing facial treatment', 'Facial', 90, 120.00, '#45B7D1'),
('ee0e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000', 'Makeup Application', 'Professional makeup application', 'Makeup', 75, 95.00, '#F7DC6F');

-- Sample appointments
INSERT INTO appointments (id, tenant_id, client_id, professional_id, service_id, scheduled_at, duration_minutes, status, total_amount) VALUES 
('ff0e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000', '990e8400-e29b-41d4-a716-446655440000', 'aa0e8400-e29b-41d4-a716-446655440000', 'bb0e8400-e29b-41d4-a716-446655440000', '2026-01-05 10:00:00', 60, 'scheduled', 85.00),
('001e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440000', '990e8400-e29b-41d4-a716-446655440000', 'aa0e8400-e29b-41d4-a716-446655440000', 'cc0e8400-e29b-41d4-a716-446655440000', '2026-01-05 14:30:00', 45, 'scheduled', 35.00);

-- Create views for easier querying
CREATE VIEW client_summary AS
SELECT 
    c.id,
    c.tenant_id,
    c.first_name,
    c.last_name,
    c.email,
    c.phone,
    c.loyalty_points,
    c.total_spent,
    c.last_visit_at,
    u.email_verified,
    COUNT(a.id) as total_appointments,
    COUNT(CASE WHEN a.status = 'completed' THEN 1 END) as completed_appointments
FROM clients c
LEFT JOIN users u ON c.user_id = u.id
LEFT JOIN appointments a ON c.id = a.client_id
GROUP BY c.id, c.tenant_id, c.first_name, c.last_name, c.email, c.phone, c.loyalty_points, c.total_spent, c.last_visit_at, u.email_verified;

CREATE VIEW professional_schedule AS
SELECT 
    p.id,
    p.tenant_id,
    p.first_name,
    p.last_name,
    p.email,
    p.specializations,
    p.hourly_rate,
    a.id as appointment_id,
    a.scheduled_at,
    a.duration_minutes,
    a.status,
    c.first_name as client_first_name,
    c.last_name as client_last_name,
    s.name as service_name
FROM professionals p
LEFT JOIN appointments a ON p.id = a.professional_id
LEFT JOIN clients c ON a.client_id = c.id
LEFT JOIN services s ON a.service_id = s.id
WHERE a.scheduled_at >= CURRENT_DATE
ORDER BY a.scheduled_at;

-- Grant permissions (adjust based on your security requirements)
-- For development, we'll use the postgres user
-- In production, create specific users with limited permissions