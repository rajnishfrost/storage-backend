const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

// Login route
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email }).populate('role');

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user._id);

    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role ? user.role.name : null,
        roleId: user.role ? user.role._id : null,
        storageQuota: user.storageQuota,
        usedStorage: user.usedStorage,
        storagePath: user.storagePath
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// Get current user info
router.get('/me', authenticate, async (req, res) => {
  try {
    res.json({
      id: req.user._id,
      email: req.user.email,
      role: req.user.role ? req.user.role.name : null,
      roleId: req.user.role ? req.user.role._id : null,
      storageQuota: req.user.storageQuota,
      usedStorage: req.user.usedStorage,
      storagePath: req.user.storagePath
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
