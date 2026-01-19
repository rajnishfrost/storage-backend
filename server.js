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
    const adminRole = await Role.findOne({ name: 'admin' });
    const userRole = await Role.findOne({ name: 'user' });

    // Migrate existing users from string role to ObjectId role
    const User = require('./models/User');

    // Use native MongoDB collection to bypass schema validation for migration
    const usersCollection = mongoose.connection.collection('users');
    const usersWithStringRole = await usersCollection.find({
      role: { $type: 'string' }
    }).toArray();

    for (const user of usersWithStringRole) {
      let newRoleId;
      if (user.role === 'super_admin') {
        newRoleId = superAdminRole._id;
      } else if (user.role === 'admin') {
        newRoleId = adminRole._id;
      } else {
        newRoleId = userRole._id;
      }

      await usersCollection.updateOne(
        { _id: user._id },
        { $set: { role: newRoleId } }
      );
      console.log(`Migrated user ${user.email} role to ObjectId`);
    }

    // Create super admin if not exists
    const superAdminExists = await User.findOne({ role: superAdminRole._id });

    if (!superAdminExists) {
      const superAdmin = new User({
        email: process.env.SUPER_ADMIN_EMAIL || 'superadmin@cloudstore.com',
        password: process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin@123',
        role: superAdminRole._id,
        storageQuota: 1000, // 1TB for super admin
        storagePath: process.env.UPLOAD_PATH || './uploads'
      });

      await superAdmin.save();
      console.log('Super admin created successfully');
      console.log('Email:', superAdmin.email);
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
