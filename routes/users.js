const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const UserDetails = require('../models/UserDetails');
const File = require('../models/File');
const Role = require('../models/Role');
const validateExternalToken = require('../middleware/validateExternalToken');
const { isAdmin } = require('../middleware/auth');

// Get all users (admin only)
router.get('/', validateExternalToken, isAdmin, async (req, res) => {
  try {
    const superAdminRole = await Role.findOne({ name: 'super_admin' });

    const userDetails = await UserDetails.find({ role: { $ne: superAdminRole._id } })
      .populate('role')
      .sort({ createdAt: -1 });

    // Calculate actual used storage from File collection for each user
    const usersWithStorage = await Promise.all(
      userDetails.map(async (user) => {
        try {
          const ownerId = new mongoose.Types.ObjectId(user.externalUserId);
          const storageAgg = await File.aggregate([
            { $match: { owner: ownerId } },
            { $group: { _id: null, totalSize: { $sum: '$size' } } }
          ]);
          const actualUsed = storageAgg.length > 0 ? storageAgg[0].totalSize : 0;

          // Sync usedStorage if out of date
          if (user.usedStorage !== actualUsed) {
            user.usedStorage = actualUsed;
            await user.save();
          }
        } catch (aggErr) {
          console.error(`Storage calc error for ${user.email}:`, aggErr.message);
        }

        return user;
      })
    );

    res.json(usersWithStorage);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new user (admin only) - Creates user in external API + local user_details
router.post('/', validateExternalToken, isAdmin, async (req, res) => {
  try {
    const axios = require('axios');
    const { name, email, password, roleId, storageQuota, storagePath } = req.body;
    const EXTERNAL_AUTH_API = process.env.EXTERNAL_AUTH_API || 'http://161.118.173.163:4000';

    // Validation
    if (!name || !email || !password || !roleId) {
      return res.status(400).json({ error: 'Name, email, password and role are required' });
    }

    // Check if role exists
    const roleDoc = await Role.findById(roleId);
    if (!roleDoc) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Only super admin can create admin users
    if (roleDoc.name === 'admin' && req.userDetails.roleName !== 'super_admin') {
      return res.status(403).json({ error: 'Only super admin can create admin users' });
    }

    // Validate custom storage path if provided
    const finalStoragePath = storagePath || process.env.UPLOAD_PATH || './uploads';
    if (storagePath && storagePath.trim() !== '') {
      const fs = require('fs-extra');

      try {
        const exists = await fs.pathExists(storagePath);
        if (!exists) {
          return res.status(400).json({
            error: `Storage path does not exist: ${storagePath}. Please create the directory first or ensure you have the correct path.`
          });
        }

        await fs.access(storagePath, fs.constants.W_OK);
      } catch (accessError) {
        return res.status(400).json({
          error: `Cannot write to storage path: ${storagePath}. Please check directory permissions.`
        });
      }
    }

    // 1. Create user in external API
    let externalResponse;
    try {
      externalResponse = await axios.post(`${EXTERNAL_AUTH_API}/api/auth/signup`, {
        name,
        email,
        password,
        signup_platform: 'storage',
        signup_way: 'email'
      });
    } catch (error) {
      const errorMessage = error.response?.data?.message || error.response?.data?.error || 'Signup failed';
      return res.status(error.response?.status || 400).json({ error: errorMessage });
    }

    const { _id: externalUserId } = externalResponse.data;

    // 2. Create user_details locally
    const userDetails = await UserDetails.create({
      externalUserId,
      name,
      email,
      role: roleId,
      roleName: roleDoc.name,
      storageQuota: storageQuota || 5,
      usedStorage: 0,
      storagePath: finalStoragePath,
      isActive: true,
      createdBy: req.user._id
    });

    await userDetails.populate('role');

    res.status(201).json({
      id: userDetails._id,
      externalUserId: userDetails.externalUserId,
      role: userDetails.role,
      storageQuota: userDetails.storageQuota,
      storagePath: userDetails.storagePath,
      isActive: userDetails.isActive
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (admin only) - Updates user_details only (passwords managed via external API)
router.put('/:userId', validateExternalToken, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { storageQuota, storagePath, isActive, roleId } = req.body;

    const userDetails = await UserDetails.findById(userId).populate('role');

    if (!userDetails) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent modifying super admin
    if (userDetails.roleName === 'super_admin') {
      return res.status(403).json({ error: 'Cannot modify super admin' });
    }

    // Check new role if being updated
    if (roleId) {
      const Role = require('../models/Role');
      const newRole = await Role.findById(roleId);

      if (!newRole) {
        return res.status(400).json({ error: 'Invalid role' });
      }

      // Only super admin can change roles to admin
      if (newRole.name === 'admin' && req.userDetails.roleName !== 'super_admin') {
        return res.status(403).json({ error: 'Only super admin can create admin users' });
      }

      userDetails.role = roleId;
      userDetails.roleName = newRole.name;
    }

    // Validate custom storage path if being updated
    if (storagePath !== undefined && storagePath.trim() !== '') {
      const fs = require('fs-extra');

      try {
        const exists = await fs.pathExists(storagePath);
        if (!exists) {
          return res.status(400).json({
            error: `Storage path does not exist: ${storagePath}. Please create the directory first or ensure you have the correct path.`
          });
        }

        await fs.access(storagePath, fs.constants.W_OK);
      } catch (accessError) {
        return res.status(400).json({
          error: `Cannot write to storage path: ${storagePath}. Please check directory permissions.`
        });
      }
    }

    // Update fields (password changes must be done via external API)
    if (storageQuota !== undefined) userDetails.storageQuota = storageQuota;
    if (storagePath !== undefined) userDetails.storagePath = storagePath;
    if (isActive !== undefined) userDetails.isActive = isActive;

    await userDetails.save();
    await userDetails.populate('role');

    res.json({
      id: userDetails._id,
      externalUserId: userDetails.externalUserId,
      role: userDetails.role,
      roleName: userDetails.roleName,
      storageQuota: userDetails.storageQuota,
      storagePath: userDetails.storagePath,
      isActive: userDetails.isActive,
      usedStorage: userDetails.usedStorage
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user (admin only) - Deletes user_details only (external API user remains)
router.delete('/:userId', validateExternalToken, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const userDetails = await UserDetails.findById(userId).populate('role');

    if (!userDetails) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent deleting super admin
    if (userDetails.roleName === 'super_admin') {
      return res.status(403).json({ error: 'Cannot delete super admin' });
    }

    await UserDetails.findByIdAndDelete(userId);

    res.json({ message: 'User details deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
