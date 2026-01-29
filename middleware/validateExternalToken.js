const axios = require('axios');

const EXTERNAL_AUTH_API = process.env.EXTERNAL_AUTH_API || 'http://161.118.173.163:4000';

/**
 * Middleware to validate JWT token with external authentication API
 * Replaces the local JWT validation
 */
const validateExternalToken = async (req, res, next) => {
  try {
    // Extract token from Authorization header or query parameter
    const authHeader = req.headers.authorization;
    let token;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.replace('Bearer ', '');
    } else if (req.query.token) {
      // Support token in query parameter for iframe/img/video/audio tags
      token = req.query.token;
    } else {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Validate token with external API by calling /api/auth/me
    const response = await axios.get(`${EXTERNAL_AUTH_API}/api/auth/me`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    // External API returns: { _id, name, email }
    req.user = response.data;
    req.token = token;

    next();
  } catch (error) {
    // If external API returns 401 or any error, token is invalid
    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    console.error('Token validation error:', error.message);
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

module.exports = validateExternalToken;
