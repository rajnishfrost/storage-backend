const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { authenticate, isAdmin } = require('../middleware/auth');

// Get all users (admin only)
router.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const Role = require('../models/Role');
    const superAdminRole = await Role.findOne({ name: 'super_admin' });

    const users = await User.find({ role: { $ne: superAdminRole._id } })
      .select('-password')
      .populate('role')
      .sort({ createdAt: -1 });

    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new user (admin only)
router.post('/', authenticate, isAdmin, async (req, res) => {
  try {
    const { email, password, roleId, storageQuota, storagePath } = req.body;

    // Validation
    if (!email || !password || !roleId) {
      return res.status(400).json({ error: 'Email, password and role are required' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Check if role exists
    const Role = require('../models/Role');
    const roleDoc = await Role.findById(roleId);
    if (!roleDoc) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Only super admin can create admin users
    if (roleDoc.name === 'admin' && req.user.role.name !== 'super_admin') {
      return res.status(403).json({ error: 'Only super admin can create admin users' });
    }

    // Validate custom storage path if provided
    const finalStoragePath = storagePath || process.env.UPLOAD_PATH || './uploads';
    if (storagePath && storagePath.trim() !== '') {
      const fs = require('fs-extra');
      const path = require('path');

      try {
        // Check if the directory exists
        const exists = await fs.pathExists(storagePath);
        if (!exists) {
          return res.status(400).json({
            error: `Storage path does not exist: ${storagePath}. Please create the directory first or ensure you have the correct path.`
          });
        }

        // Check if we can write to the directory
        await fs.access(storagePath, fs.constants.W_OK);
      } catch (accessError) {
        return res.status(400).json({
          error: `Cannot write to storage path: ${storagePath}. Please check directory permissions.`
        });
      }
    }

    // Create user
    const user = new User({
      email,
      password,
      role: roleId,
      storageQuota: storageQuota || 5,
      storagePath: finalStoragePath,
      createdBy: req.userId
    });

    await user.save();
    await user.populate('role');

    res.status(201).json({
      id: user._id,
      email: user.email,
      role: user.role,
      storageQuota: user.storageQuota,
      storagePath: user.storagePath,
      isActive: user.isActive
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (admin only)
router.put('/:userId', authenticate, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { storageQuota, storagePath, isActive, roleId, password } = req.body;

    const user = await User.findById(userId).populate('role');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent modifying super admin
    if (user.role && user.role.name === 'super_admin') {
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
      if (newRole.name === 'admin' && req.user.role.name !== 'super_admin') {
        return res.status(403).json({ error: 'Only super admin can create admin users' });
      }

      user.role = roleId;
    }

    // Validate custom storage path if being updated
    if (storagePath !== undefined && storagePath.trim() !== '') {
      const fs = require('fs-extra');

      try {
        // Check if the directory exists
        const exists = await fs.pathExists(storagePath);
        if (!exists) {
          return res.status(400).json({
            error: `Storage path does not exist: ${storagePath}. Please create the directory first or ensure you have the correct path.`
          });
        }

        // Check if we can write to the directory
        await fs.access(storagePath, fs.constants.W_OK);
      } catch (accessError) {
        return res.status(400).json({
          error: `Cannot write to storage path: ${storagePath}. Please check directory permissions.`
        });
      }
    }

    // Update fields
    if (storageQuota !== undefined) user.storageQuota = storageQuota;
    if (storagePath !== undefined) user.storagePath = storagePath;
    if (isActive !== undefined) user.isActive = isActive;
    if (password && password.trim() !== '') {
      user.password = password; // Will be hashed by pre-save hook
    }

    await user.save();
    await user.populate('role');

    res.json({
      id: user._id,
      email: user.email,
      role: user.role,
      storageQuota: user.storageQuota,
      storagePath: user.storagePath,
      isActive: user.isActive,
      usedStorage: user.usedStorage
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user (admin only)
router.delete('/:userId', authenticate, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId).populate('role');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent deleting super admin
    if (user.role && user.role.name === 'super_admin') {
      return res.status(403).json({ error: 'Cannot delete super admin' });
    }

    await User.findByIdAndDelete(userId);

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
