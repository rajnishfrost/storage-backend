const UserDetails = require('../models/UserDetails');

// Check if user is admin or super admin (works with external auth)
// This middleware should be used AFTER validateExternalToken
const isAdmin = async (req, res, next) => {
  try {
    // req.user contains { _id, name, email } from external API
    const userDetails = await UserDetails.findOne({
      externalUserId: req.user._id
    }).populate('role');

    if (!userDetails) {
      return res.status(403).json({ error: 'User details not found' });
    }

    if (userDetails.roleName === 'admin' || userDetails.roleName === 'super_admin') {
      // Attach userDetails to request for later use
      req.userDetails = userDetails;
      next();
    } else {
      res.status(403).json({ error: 'Access denied. Admin privileges required.' });
    }
  } catch (error) {
    console.error('isAdmin error:', error);
    res.status(500).json({ error: 'Authorization check failed' });
  }
};

// Check if user is super admin (works with external auth)
// This middleware should be used AFTER validateExternalToken
const isSuperAdmin = async (req, res, next) => {
  try {
    // req.user contains { _id, name, email } from external API
    const userDetails = await UserDetails.findOne({
      externalUserId: req.user._id
    }).populate('role');

    if (!userDetails) {
      return res.status(403).json({ error: 'User details not found' });
    }

    if (userDetails.roleName === 'super_admin') {
      // Attach userDetails to request for later use
      req.userDetails = userDetails;
      next();
    } else {
      res.status(403).json({ error: 'Access denied. Super admin privileges required.' });
    }
  } catch (error) {
    console.error('isSuperAdmin error:', error);
    res.status(500).json({ error: 'Authorization check failed' });
  }
};

module.exports = { isAdmin, isSuperAdmin, requireAdmin: isAdmin };
