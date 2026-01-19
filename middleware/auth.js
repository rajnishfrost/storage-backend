const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Verify JWT token
const authenticate = async (req, res, next) => {
  try {
    // Accept token from header or query parameter (for file viewing in iframe/img/video tags)
    let token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'No authentication token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).populate('role');

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    req.user = user;
    req.userId = user._id;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Check if user is admin or super admin
const isAdmin = (req, res, next) => {
  if (req.user.role && (req.user.role.name === 'admin' || req.user.role.name === 'super_admin')) {
    next();
  } else {
    res.status(403).json({ error: 'Access denied. Admin privileges required.' });
  }
};

// Check if user is super admin
const isSuperAdmin = (req, res, next) => {
  if (req.user.role && req.user.role.name === 'super_admin') {
    next();
  } else {
    res.status(403).json({ error: 'Access denied. Super admin privileges required.' });
  }
};

module.exports = { authenticate, isAdmin, isSuperAdmin };
