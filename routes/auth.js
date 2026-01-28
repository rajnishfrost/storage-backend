const express = require('express');
const router = express.Router();
const axios = require('axios');
const UserDetails = require('../models/UserDetails');
const Role = require('../models/Role');
const validateExternalToken = require('../middleware/validateExternalToken');

const EXTERNAL_AUTH_API = process.env.EXTERNAL_AUTH_API || 'http://161.118.173.163:4000';

// Signup route - Create user in external API + local user_details
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, role = 'user', storageQuota = 5 } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }

    // 1. Create user in external authentication API
    let externalResponse;
    try {
      externalResponse = await axios.post(`${EXTERNAL_AUTH_API}/api/auth/signup`, {
        name,
        email,
        password
      });
    } catch (error) {
      // External API error (e.g., email already exists)
      const errorMessage = error.response?.data?.message || error.response?.data?.error || 'Signup failed';
      return res.status(error.response?.status || 400).json({ error: errorMessage });
    }

    const { _id: externalUserId, token } = externalResponse.data;

    // 2. Create user_details in local database
    try {
      // Find the role
      const roleDoc = await Role.findOne({ name: role });
      if (!roleDoc) {
        return res.status(400).json({ error: `Role '${role}' not found` });
      }

      // Check if user_details already exists (shouldn't happen, but just in case)
      let userDetails = await UserDetails.findOne({ externalUserId });

      if (!userDetails) {
        userDetails = await UserDetails.create({
          externalUserId,
          role: roleDoc._id,
          roleName: roleDoc.name,
          storageQuota,
          usedStorage: 0,
          storagePath: './uploads',
          isActive: true
        });
      }

      // 3. Return token and enriched user data
      res.status(201).json({
        token,
        user: {
          id: externalUserId,
          name,
          email,
          role: roleDoc.name,
          roleId: roleDoc._id,
          storageQuota: userDetails.storageQuota,
          usedStorage: userDetails.usedStorage,
          storagePath: userDetails.storagePath
        }
      });
    } catch (dbError) {
      console.error('Database error during signup:', dbError);
      return res.status(500).json({ error: 'Failed to create user details' });
    }
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

// Login route - Authenticate with external API + enrich with local data
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // 1. Authenticate with external API
    let externalResponse;
    try {
      externalResponse = await axios.post(`${EXTERNAL_AUTH_API}/api/auth/login`, {
        email,
        password
      });
    } catch (error) {
      // External API error (invalid credentials)
      const errorMessage = error.response?.data?.message || error.response?.data?.error || 'Invalid credentials';
      return res.status(error.response?.status || 401).json({ error: errorMessage });
    }

    const { _id: externalUserId, name, token } = externalResponse.data;

    // 2. Find or create user_details
    let userDetails = await UserDetails.findOne({ externalUserId }).populate('role');

    if (!userDetails) {
      // First-time login: create user_details with default role
      const defaultRole = await Role.findOne({ name: 'user' });

      if (!defaultRole) {
        return res.status(500).json({ error: 'Default role not found. Please contact administrator.' });
      }

      userDetails = await UserDetails.create({
        externalUserId,
        role: defaultRole._id,
        roleName: 'user',
        storageQuota: 5,
        usedStorage: 0,
        storagePath: './uploads',
        isActive: true
      });

      await userDetails.populate('role');
    }
    // No need to sync name/email - external API is source of truth

    // 3. Check if user is active
    if (!userDetails.isActive) {
      return res.status(403).json({ error: 'Account is deactivated. Please contact administrator.' });
    }

    // 4. Return token and enriched user data
    res.json({
      token,
      user: {
        id: externalUserId,
        name, // From external API response
        email, // From external API request
        role: userDetails.roleName,
        roleId: userDetails.role._id,
        storageQuota: userDetails.storageQuota,
        usedStorage: userDetails.usedStorage,
        storagePath: userDetails.storagePath
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// Get current user info - Validate token with external API + enrich with local data
router.get('/me', validateExternalToken, async (req, res) => {
  try {
    // req.user contains { _id, name, email } from external API
    const userDetails = await UserDetails.findOne({
      externalUserId: req.user._id
    }).populate('role');

    if (!userDetails) {
      return res.status(404).json({ error: 'User details not found' });
    }

    // External API is source of truth for name/email - no syncing needed

    res.json({
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      role: userDetails.roleName,
      roleId: userDetails.role._id,
      storageQuota: userDetails.storageQuota,
      usedStorage: userDetails.usedStorage,
      storagePath: userDetails.storagePath
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Change password - Proxy to external API
router.post('/change-password', validateExternalToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    // Proxy password change request to external API
    try {
      await axios.put(
        `${EXTERNAL_AUTH_API}/api/users/password`,
        {
          currentPassword,
          newPassword
        },
        {
          headers: {
            'Authorization': `Bearer ${req.token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      res.json({ message: 'Password changed successfully' });
    } catch (error) {
      const errorMessage = error.response?.data?.message || error.response?.data?.error || 'Password change failed';
      return res.status(error.response?.status || 400).json({ error: errorMessage });
    }
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Server error during password change' });
  }
});

module.exports = router;
