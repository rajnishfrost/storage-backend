const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const roleRoutes = require('./routes/roles');
const fileRoutes = require('./routes/files');
const folderRoutes = require('./routes/folders');
const adminRoutes = require('./routes/admin');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase JSON body limit
app.use(express.urlencoded({ extended: true, limit: '50mb' })); // Increase URL-encoded body limit

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/admin', adminRoutes);

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
        isSystemRole: true
      },
      {
        name: 'admin',
        displayName: 'Admin',
        description: 'Administrative access with user management',
        permissions: ['read_files', 'write_files', 'delete_files', 'manage_users', 'view_analytics'],
        isSystemRole: true
      },
      {
        name: 'user',
        displayName: 'User',
        description: 'Standard user with basic file access',
        permissions: ['read_files', 'write_files', 'delete_files'],
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

    // Get role IDs
    const superAdminRole = await Role.findOne({ name: 'super_admin' });

    // Create super admin in external API + local user_details if not exists
    const UserDetails = require('./models/UserDetails');
    const axios = require('axios');
    const EXTERNAL_AUTH_API = process.env.EXTERNAL_AUTH_API || 'http://161.118.173.163:4000';

    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'superadmin@cloudstore.com';
    const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin@123';

    // Check if super admin user_details exists
    const superAdminExists = await UserDetails.findOne({ role: superAdminRole._id });

    if (!superAdminExists) {
      try {
        console.log('Creating super admin in external API...');

        // Try to create super admin in external API
        const signupResponse = await axios.post(`${EXTERNAL_AUTH_API}/api/auth/signup`, {
          name: 'Super Admin',
          email: superAdminEmail,
          password: superAdminPassword
        });

        const { _id: externalUserId } = signupResponse.data;

        // Create user_details for super admin
        await UserDetails.create({
          externalUserId,
          name: 'Super Admin',
          email: superAdminEmail,
          role: superAdminRole._id,
          roleName: 'super_admin',
          storageQuota: 1000, // 1TB for super admin
          usedStorage: 0,
          storagePath: process.env.UPLOAD_PATH || './uploads',
          isActive: true
        });

        console.log('Super admin created successfully');
        console.log('Email:', superAdminEmail);
      } catch (error) {
        // If signup fails (e.g., user already exists in external API), try to login
        if (error.response?.status === 400) {
          console.log('Super admin may already exist in external API, attempting login...');

          try {
            const loginResponse = await axios.post(`${EXTERNAL_AUTH_API}/api/auth/login`, {
              email: superAdminEmail,
              password: superAdminPassword
            });

            const { _id: externalUserId } = loginResponse.data;

            // Create user_details for existing super admin
            await UserDetails.create({
              externalUserId,
              name: 'Super Admin',
              email: superAdminEmail,
              role: superAdminRole._id,
              roleName: 'super_admin',
              storageQuota: 1000,
              usedStorage: 0,
              storagePath: process.env.UPLOAD_PATH || './uploads',
              isActive: true
            });

            console.log('Super admin user_details created successfully');
            console.log('Email:', superAdminEmail);
          } catch (loginError) {
            console.error('Failed to create/link super admin:', loginError.message);
          }
        } else {
          console.error('Failed to create super admin:', error.message);
        }
      }
    }

    // Start server - bind to 0.0.0.0 to allow network access
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
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
