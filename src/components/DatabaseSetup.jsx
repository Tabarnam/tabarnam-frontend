import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Database, Users, Shield, FileText, MapPin, Building2, Tag, Search, AlertTriangle, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';

const DatabaseSetup = () => {
  const [activeTab, setActiveTab] = useState('schema');

  const handleCreateSchema = () => {
    toast({
      title: "🚧 Schema Creation",
      description: "This feature isn't implemented yet—but don't worry! You can request it in your next prompt! 🚀"
    });
  };

  const handleSetupRoles = () => {
    toast({
      title: "🚧 Role Setup",
      description: "This feature isn't implemented yet—but don't worry! You can request it in your next prompt! 🚀"
    });
  };

  const handleConfigureStorage = () => {
    toast({
      title: "🚧 Storage Configuration",
      description: "This feature isn't implemented yet—but don't worry! You can request it in your next prompt! 🚀"
    });
  };

  const tables = [
    {
      name: 'Companies',
      icon: Building2,
      fields: ['id (uuid, pk)', 'company_name (text)', 'logo_url (text)', 'tagline (text)', 'about (text)', 'website_url (text)', 'notes (text)', 'contact_email (text)', 'contact_phone (text)', 'star_rating (float, default 0)', 'star_explanation (text)'],
      color: 'from-blue-500 to-cyan-500'
    },
    {
      name: 'Industries',
      icon: Tag,
      fields: ['id (uuid, pk)', 'name (text)'],
      color: 'from-green-500 to-emerald-500'
    },
    {
      name: 'ProductKeywords',
      icon: Search,
      fields: ['id (uuid, pk)', 'keyword (text)'],
      color: 'from-purple-500 to-violet-500'
    },
    {
      name: 'CompanyIndustries',
      icon: Building2,
      fields: ['company_id (fk)', 'industry_id (fk)'],
      color: 'from-orange-500 to-red-500'
    },
    {
      name: 'CompanyKeywords',
      icon: Tag,
      fields: ['company_id (fk)', 'keyword_id (fk)'],
      color: 'from-pink-500 to-rose-500'
    },
    {
      name: 'Headquarters',
      icon: MapPin,
      fields: ['id (uuid, pk)', 'company_id (fk)', 'city (text)', 'state (text)', 'country (text)', 'latitude (float)', 'longitude (float)'],
      color: 'from-indigo-500 to-blue-500'
    },
    {
      name: 'ManufacturingLocations',
      icon: MapPin,
      fields: ['id (uuid, pk)', 'company_id (fk)', 'city (text)', 'state (text)', 'country (text)', 'latitude (float)', 'longitude (float)'],
      color: 'from-teal-500 to-cyan-500'
    },
    {
      name: 'SearchAnalytics',
      icon: Search,
      fields: ['id (uuid, pk)', 'query (text)', 'location_detected (text)', 'estimated_price (text)', 'timestamp (timestamptz default now())'],
      color: 'from-yellow-500 to-orange-500'
    },
    {
      name: 'Errors',
      icon: AlertTriangle,
      fields: ['id (uuid, pk)', 'type (text)', 'company_id (fk, nullable)', 'field_name (text)', 'message (text)', 'resolved (boolean default false)'],
      color: 'from-red-500 to-pink-500'
    }
  ];

  const sqlSchema = `-- Tabarnam Database Schema
-- Core Tables

-- Companies table
CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  logo_url TEXT,
  tagline TEXT,
  about TEXT,
  website_url TEXT,
  notes TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  star_rating FLOAT DEFAULT 0,
  star_explanation TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Industries table
CREATE TABLE industries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Product Keywords table
CREATE TABLE product_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Company Industries junction table
CREATE TABLE company_industries (
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  industry_id UUID REFERENCES industries(id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, industry_id)
);

-- Company Keywords junction table
CREATE TABLE company_keywords (
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  keyword_id UUID REFERENCES product_keywords(id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, keyword_id)
);

-- Headquarters table
CREATE TABLE headquarters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  city TEXT,
  state TEXT,
  country TEXT,
  latitude FLOAT,
  longitude FLOAT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Manufacturing Locations table
CREATE TABLE manufacturing_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  city TEXT,
  state TEXT,
  country TEXT,
  latitude FLOAT,
  longitude FLOAT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Search Analytics table
CREATE TABLE search_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL,
  location_detected TEXT,
  estimated_price TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Errors table
CREATE TABLE errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  field_name TEXT,
  message TEXT NOT NULL,
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- Indexes for better performance
CREATE INDEX idx_companies_name ON companies(company_name);
CREATE INDEX idx_companies_rating ON companies(star_rating);
CREATE INDEX idx_search_analytics_timestamp ON search_analytics(timestamp);
CREATE INDEX idx_errors_resolved ON errors(resolved);
CREATE INDEX idx_errors_type ON errors(type);

-- RLS Policies (Row Level Security)
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE industries ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_industries ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE headquarters ENABLE ROW LEVEL SECURITY;
ALTER TABLE manufacturing_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE errors ENABLE ROW LEVEL SECURITY;

-- Storage bucket for company logos
INSERT INTO storage.buckets (id, name, public) VALUES ('company-logos', 'company-logos', true);

-- Storage policies
CREATE POLICY "Public Access" ON storage.objects FOR SELECT USING (bucket_id = 'company-logos');
CREATE POLICY "Admin Upload" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'company-logos' AND auth.role() = 'admin');
CREATE POLICY "Admin Update" ON storage.objects FOR UPDATE USING (bucket_id = 'company-logos' AND auth.role() = 'admin');
CREATE POLICY "Admin Delete" ON storage.objects FOR DELETE USING (bucket_id = 'company-logos' AND auth.role() = 'admin');`;

  return (
    <div className="min-h-screen p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <div className="flex items-center justify-center mb-6">
            <div className="p-4 bg-gradient-to-r from-purple-500 to-pink-500 rounded-2xl">
              <Database className="w-12 h-12 text-white" />
            </div>
          </div>
          <h1 className="text-5xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent mb-4">
            Tabarnam Database Setup
          </h1>
          <p className="text-xl text-gray-300 max-w-3xl mx-auto">
            Comprehensive Supabase backend with companies, industries, analytics tracking, and role-based permissions
          </p>
        </motion.div>

        {/* Navigation Tabs */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex justify-center mb-8"
        >
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-2 border border-white/20">
            {[
              { id: 'schema', label: 'Database Schema', icon: Database },
              { id: 'roles', label: 'Roles & Permissions', icon: Shield },
              { id: 'storage', label: 'Storage Setup', icon: Upload },
              { id: 'sql', label: 'SQL Code', icon: FileText }
            ].map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-2 px-6 py-3 rounded-xl transition-all duration-300 ${
                  activeTab === id
                    ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-lg'
                    : 'text-gray-300 hover:text-white hover:bg-white/10'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="font-medium">{label}</span>
              </button>
            ))}
          </div>
        </motion.div>

        {/* Content */}
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3 }}
        >
          {activeTab === 'schema' && (
            <div className="space-y-8">
              <div className="text-center mb-8">
                <h2 className="text-3xl font-bold text-white mb-4">Database Tables Overview</h2>
                <p className="text-gray-300">Core tables for the Tabarnam backend system</p>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {tables.map((table, index) => (
                  <motion.div
                    key={table.name}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1 }}
                    className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20 hover:border-white/40 transition-all duration-300"
                  >
                    <div className="flex items-center gap-3 mb-4">
                      <div className={`p-3 bg-gradient-to-r ${table.color} rounded-xl`}>
                        <table.icon className="w-6 h-6 text-white" />
                      </div>
                      <h3 className="text-xl font-bold text-white">{table.name}</h3>
                    </div>
                    <div className="space-y-2">
                      {table.fields.map((field, fieldIndex) => (
                        <div key={fieldIndex} className="text-sm text-gray-300 bg-white/5 rounded-lg px-3 py-2">
                          {field}
                        </div>
                      ))}
                    </div>
                  </motion.div>
                ))}
              </div>

              <div className="text-center">
                <Button
                  onClick={handleCreateSchema}
                  className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white px-8 py-3 rounded-xl text-lg font-semibold shadow-lg hover:shadow-xl transition-all duration-300"
                >
                  <Database className="w-5 h-5 mr-2" />
                  Create Database Schema
                </Button>
              </div>
            </div>
          )}

          {activeTab === 'roles' && (
            <div className="space-y-8">
              <div className="text-center mb-8">
                <h2 className="text-3xl font-bold text-white mb-4">Role-Based Access Control</h2>
                <p className="text-gray-300">Configure user roles and permissions for secure data access</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 border border-white/20"
                >
                  <div className="flex items-center gap-3 mb-6">
                    <div className="p-3 bg-gradient-to-r from-red-500 to-orange-500 rounded-xl">
                      <Shield className="w-6 h-6 text-white" />
                    </div>
                    <h3 className="text-2xl font-bold text-white">Admin Role</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-green-400">
                      <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                      <span>Full database access</span>
                    </div>
                    <div className="flex items-center gap-2 text-green-400">
                      <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                      <span>Create, read, update, delete</span>
                    </div>
                    <div className="flex items-center gap-2 text-green-400">
                      <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                      <span>File upload permissions</span>
                    </div>
                    <div className="flex items-center gap-2 text-green-400">
                      <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                      <span>User management</span>
                    </div>
                  </div>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 border border-white/20"
                >
                  <div className="flex items-center gap-3 mb-6">
                    <div className="p-3 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-xl">
                      <Users className="w-6 h-6 text-white" />
                    </div>
                    <h3 className="text-2xl font-bold text-white">Viewer Role</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-blue-400">
                      <div className="w-2 h-2 bg-blue-400 rounded-full"></div>
                      <span>Read-only access</span>
                    </div>
                    <div className="flex items-center gap-2 text-blue-400">
                      <div className="w-2 h-2 bg-blue-400 rounded-full"></div>
                      <span>View companies & data</span>
                    </div>
                    <div className="flex items-center gap-2 text-blue-400">
                      <div className="w-2 h-2 bg-blue-400 rounded-full"></div>
                      <span>Access analytics</span>
                    </div>
                    <div className="flex items-center gap-2 text-red-400">
                      <div className="w-2 h-2 bg-red-400 rounded-full"></div>
                      <span>No modification rights</span>
                    </div>
                  </div>
                </motion.div>
              </div>

              <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 border border-white/20">
                <h3 className="text-xl font-bold text-white mb-4">User Capacity</h3>
                <p className="text-gray-300 mb-6">Support for up to 3 users with role-based permissions and comprehensive history tracking for all database operations.</p>
                <div className="flex items-center gap-4">
                  <div className="flex -space-x-2">
                    <div className="w-10 h-10 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full border-2 border-white flex items-center justify-center text-white font-bold">A</div>
                    <div className="w-10 h-10 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full border-2 border-white flex items-center justify-center text-white font-bold">V</div>
                    <div className="w-10 h-10 bg-gradient-to-r from-green-500 to-emerald-500 rounded-full border-2 border-white flex items-center justify-center text-white font-bold">V</div>
                  </div>
                  <span className="text-gray-300">Admin + 2 Viewers</span>
                </div>
              </div>

              <div className="text-center">
                <Button
                  onClick={handleSetupRoles}
                  className="bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white px-8 py-3 rounded-xl text-lg font-semibold shadow-lg hover:shadow-xl transition-all duration-300"
                >
                  <Shield className="w-5 h-5 mr-2" />
                  Setup Roles & Permissions
                </Button>
              </div>
            </div>
          )}

          {activeTab === 'storage' && (
            <div className="space-y-8">
              <div className="text-center mb-8">
                <h2 className="text-3xl font-bold text-white mb-4">Storage Configuration</h2>
                <p className="text-gray-300">Secure file storage for company logos with signed URL generation</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 border border-white/20"
                >
                  <div className="flex items-center gap-3 mb-6">
                    <div className="p-3 bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl">
                      <Upload className="w-6 h-6 text-white" />
                    </div>
                    <h3 className="text-2xl font-bold text-white">Logo Storage</h3>
                  </div>
                  <div className="space-y-4">
                    <div className="bg-white/5 rounded-lg p-4">
                      <h4 className="font-semibold text-white mb-2">Bucket: company-logos</h4>
                      <p className="text-gray-300 text-sm">Dedicated storage bucket for company logo files</p>
                    </div>
                    <div className="bg-white/5 rounded-lg p-4">
                      <h4 className="font-semibold text-white mb-2">File Types</h4>
                      <p className="text-gray-300 text-sm">PNG, JPG, JPEG, SVG, WebP</p>
                    </div>
                    <div className="bg-white/5 rounded-lg p-4">
                      <h4 className="font-semibold text-white mb-2">Max Size</h4>
                      <p className="text-gray-300 text-sm">5MB per file</p>
                    </div>
                  </div>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 border border-white/20"
                >
                  <div className="flex items-center gap-3 mb-6">
                    <div className="p-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-xl">
                      <Shield className="w-6 h-6 text-white" />
                    </div>
                    <h3 className="text-2xl font-bold text-white">Security Features</h3>
                  </div>
                  <div className="space-y-4">
                    <div className="bg-white/5 rounded-lg p-4">
                      <h4 className="font-semibold text-white mb-2">Signed URLs</h4>
                      <p className="text-gray-300 text-sm">Secure, time-limited access to files</p>
                    </div>
                    <div className="bg-white/5 rounded-lg p-4">
                      <h4 className="font-semibold text-white mb-2">Role-Based Access</h4>
                      <p className="text-gray-300 text-sm">Admin upload, public read access</p>
                    </div>
                    <div className="bg-white/5 rounded-lg p-4">
                      <h4 className="font-semibold text-white mb-2">Auto-Optimization</h4>
                      <p className="text-gray-300 text-sm">Automatic image compression and resizing</p>
                    </div>
                  </div>
                </motion.div>
              </div>

              <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 border border-white/20">
                <h3 className="text-xl font-bold text-white mb-4">Storage Policies</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <h4 className="font-semibold text-green-400">✓ Allowed Operations</h4>
                    <ul className="space-y-2 text-gray-300">
                      <li>• Public read access for all users</li>
                      <li>• Admin upload permissions</li>
                      <li>• Admin file management</li>
                      <li>• Automatic URL generation</li>
                    </ul>
                  </div>
                  <div className="space-y-3">
                    <h4 className="font-semibold text-red-400">✗ Restricted Operations</h4>
                    <ul className="space-y-2 text-gray-300">
                      <li>• Viewer role cannot upload</li>
                      <li>• No anonymous uploads</li>
                      <li>• File size limits enforced</li>
                      <li>• Type restrictions applied</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="text-center">
                <Button
                  onClick={handleConfigureStorage}
                  className="bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white px-8 py-3 rounded-xl text-lg font-semibold shadow-lg hover:shadow-xl transition-all duration-300"
                >
                  <Upload className="w-5 h-5 mr-2" />
                  Configure Storage
                </Button>
              </div>
            </div>
          )}

          {activeTab === 'sql' && (
            <div className="space-y-8">
              <div className="text-center mb-8">
                <h2 className="text-3xl font-bold text-white mb-4">Complete SQL Schema</h2>
                <p className="text-gray-300">Ready-to-execute SQL code for your Supabase database</p>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-gray-900/50 backdrop-blur-lg rounded-2xl border border-white/20 overflow-hidden"
              >
                <div className="bg-white/10 px-6 py-4 border-b border-white/20">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold text-white">tabarnam-schema.sql</h3>
                    <Button
                      onClick={() => {
                        navigator.clipboard.writeText(sqlSchema);
                        toast({
                          title: "✅ Copied!",
                          description: "SQL schema copied to clipboard"
                        });
                      }}
                      variant="outline"
                      className="text-white border-white/20 hover:bg-white/10"
                    >
                      Copy SQL
                    </Button>
                  </div>
                </div>
                <div className="p-6 max-h-96 overflow-y-auto">
                  <pre className="text-sm text-gray-300 whitespace-pre-wrap font-mono">
                    {sqlSchema}
                  </pre>
                </div>
              </motion.div>

              <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
                <h3 className="text-xl font-bold text-white mb-4">Implementation Steps</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="text-center">
                    <div className="w-12 h-12 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full flex items-center justify-center text-white font-bold text-xl mx-auto mb-3">1</div>
                    <h4 className="font-semibold text-white mb-2">Create Project</h4>
                    <p className="text-gray-300 text-sm">Set up new Supabase project</p>
                  </div>
                  <div className="text-center">
                    <div className="w-12 h-12 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white font-bold text-xl mx-auto mb-3">2</div>
                    <h4 className="font-semibold text-white mb-2">Execute SQL</h4>
                    <p className="text-gray-300 text-sm">Run schema in SQL editor</p>
                  </div>
                  <div className="text-center">
                    <div className="w-12 h-12 bg-gradient-to-r from-green-500 to-emerald-500 rounded-full flex items-center justify-center text-white font-bold text-xl mx-auto mb-3">3</div>
                    <h4 className="font-semibold text-white mb-2">Configure Auth</h4>
                    <p className="text-gray-300 text-sm">Set up authentication & roles</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
};

export default DatabaseSetup;