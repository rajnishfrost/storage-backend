const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const roleRoutes = require('./routes/roles');
const fileRoutes = require('./routes/files');
const folderRoutes = require('./routes/folders');
const adminRoutes = require('./routes/admin');
const systemStorageRoutes = require('./routes/systemStorage');
const shareRoutes = require('./routes/shares');
const publicRoutes = require('./routes/public');

const app = express();

// Security middleware
// First-party origins only. Override with CORS_ORIGINS env (comma-separated) if needed.
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : [
      'https://lackoff.com',
      'https://myhabits.lackoff.com',
      'https://storage.lackoff.com',
      'https://familytrees.lackoff.com',
      'https://rj.lackoff.com',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:3003',
      'http://localhost:3004',
    ];
const corsOptions = {
  origin(origin, cb) {
    // allow non-browser callers (curl, server-to-server) that send no Origin
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
};

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' })); // Increase JSON body limit
app.use(express.urlencoded({ extended: true, limit: '50mb' })); // Increase URL-encoded body limit

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/system-storage', systemStorageRoutes);
app.use('/api/shares', shareRoutes);
app.use('/api/public', publicRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Cloud Storage API is running' });
});

// Database connection and server startup
const PORT = process.env.PORT || 5000;

const initializeApp = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected successfully');

    // Create default roles if they don't exist
    const Role = require('./models/Role');

    const defaultRoles = [
      {
        name: 'super_admin',
        displayName: 'Super Admin',
        description: 'Full system access with all permissions',
        permissions: ['read_files', 'write_files', 'delete_files', 'manage_users', 'manage_roles', 'view_analytics', 'system_settings'],
        modules: ['user-management', 'ss-management', 'role-management'],
        isSystemRole: true
      },
      {
        name: 'admin',
        displayName: 'Admin',
        description: 'Administrative access with user management',
        permissions: ['read_files', 'write_files', 'delete_files', 'manage_users', 'view_analytics'],
        modules: ['user-management'],
        isSystemRole: true
      },
      {
        name: 'user',
        displayName: 'User',
        description: 'Standard user with basic file access',
        permissions: ['read_files', 'write_files', 'delete_files'],
        modules: [],
        isSystemRole: true
      }
    ];

    for (const roleData of defaultRoles) {
      const existingRole = await Role.findOne({ name: roleData.name });
      if (!existingRole) {
        await Role.create(roleData);
        console.log(`Created default role: ${roleData.displayName}`);
      }
    }

    // Migration: ensure existing system roles have modules field
    for (const roleData of defaultRoles) {
      await Role.updateOne(
        { name: roleData.name, $or: [{ modules: { $exists: false } }, { modules: { $size: 0 }, name: { $ne: 'user' } }] },
        { $set: { modules: roleData.modules } }
      );
    }

    // Get role IDs
    const superAdminRole = await Role.findOne({ name: 'super_admin' });

    // Create super admin in external API + local user_details if not exists
    const UserDetails = require('./models/UserDetails');
    const axios = require('axios');
    const EXTERNAL_AUTH_API = process.env.EXTERNAL_AUTH_API || 'http://161.118.173.163:4000';

    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'superadmin@cloudstore.com';
    const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin@123';

    // Ensure super admin exists in local user_details
    const superAdminExists = await UserDetails.findOne({ roleName: 'super_admin' });

    if (!superAdminExists) {
      try {
        // Get or create super admin in external API
        let externalUserId;

        try {
          const signupResponse = await axios.post(`${EXTERNAL_AUTH_API}/api/auth/signup`, {
            name: 'Super Admin',
            email: superAdminEmail,
            password: superAdminPassword,
            signup_platform: 'storage',
            signup_way: 'seeded'
          });
          externalUserId = signupResponse.data._id;
        } catch (signupError) {
          // User already exists in external API - login to get their ID
          const loginResponse = await axios.post(`${EXTERNAL_AUTH_API}/api/auth/login`, {
            email: superAdminEmail,
            password: superAdminPassword
          });
          externalUserId = loginResponse.data._id;
        }

        // Use findOneAndUpdate to handle both cases:
        // - User doesn't exist → create as super_admin
        // - User exists with 'user' role (auto-created by /auth/me) → upgrade to super_admin
        await UserDetails.findOneAndUpdate(
          { externalUserId },
          {
            $set: {
              name: 'Super Admin',
              email: superAdminEmail,
              role: superAdminRole._id,
              roleName: 'super_admin',
              storageQuota: null,
              storagePath: null,
              isActive: true
            },
            $setOnInsert: {
              usedStorage: 0
            }
          },
          { upsert: true, new: true }
        );

        console.log('Super admin initialized:', superAdminEmail);
      } catch (error) {
        console.error('Failed to initialize super admin:', error.message);
      }
    }

    // Start server - bind to localhost only (reached via nginx reverse proxy)
    app.listen(PORT, '127.0.0.1', () => {
      console.log(`Server running on port ${PORT} (localhost only, behind nginx)`);
      console.log(`Local: http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Error initializing app:', error);
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  process.exit(1);
});

initializeApp();
