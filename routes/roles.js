const express = require('express');
const router = express.Router();
const Role = require('../models/Role');
const validateExternalToken = require('../middleware/validateExternalToken');
const { isSuperAdmin } = require('../middleware/auth');

// Get all roles
router.get('/', validateExternalToken, async (req, res) => {
  try {
    const roles = await Role.find().sort({ createdAt: 1 });
    res.json(roles);
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new role (super admin only)
router.post('/', validateExternalToken, isSuperAdmin, async (req, res) => {
  try {
    const { name, displayName, description, permissions } = req.body;

    if (!name || !displayName) {
      return res.status(400).json({ error: 'Name and display name are required' });
    }

    // Check if role already exists
    const existingRole = await Role.findOne({ name });
    if (existingRole) {
      return res.status(400).json({ error: 'Role with this name already exists' });
    }

    const role = new Role({
      name,
      displayName,
      description: description || '',
      permissions: permissions || [],
      isSystemRole: false,
      createdBy: req.user._id
    });

    await role.save();
    res.status(201).json(role);
  } catch (error) {
    console.error('Create role error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update role (super admin only)
router.put('/:roleId', validateExternalToken, isSuperAdmin, async (req, res) => {
  try {
    const { roleId } = req.params;
    const { displayName, description, permissions } = req.body;

    const role = await Role.findById(roleId);

    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }

    // Prevent modifying system roles' name and core permissions
    if (role.isSystemRole) {
      return res.status(403).json({ error: 'Cannot modify system role properties' });
    }

    // Update fields
    if (displayName) role.displayName = displayName;
    if (description !== undefined) role.description = description;
    if (permissions) role.permissions = permissions;

    await role.save();
    res.json(role);
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete role (super admin only)
router.delete('/:roleId', validateExternalToken, isSuperAdmin, async (req, res) => {
  try {
    const { roleId } = req.params;

    const role = await Role.findById(roleId);

    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }

    // Prevent deleting system roles
    if (role.isSystemRole) {
      return res.status(403).json({ error: 'Cannot delete system role' });
    }

    // Check if any users have this role
    const UserDetails = require('../models/UserDetails');
    const usersWithRole = await UserDetails.countDocuments({ role: roleId });

    if (usersWithRole > 0) {
      return res.status(400).json({
        error: `Cannot delete role. ${usersWithRole} user(s) currently have this role.`
      });
    }

    await Role.findByIdAndDelete(roleId);
    res.json({ message: 'Role deleted successfully' });
  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
