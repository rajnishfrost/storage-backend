const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const UserDetails = require('../models/UserDetails');
const validateExternalToken = require('../middleware/validateExternalToken');
const { requireAdmin } = require('../middleware/auth');

// Get storage paths with disk space info
router.get('/storage-paths', validateExternalToken, requireAdmin, async (req, res) => {
  try {
    const userDetails = await UserDetails.findOne({ externalUserId: req.user._id });

    if (!userDetails.storagePaths || userDetails.storagePaths.length === 0) {
      return res.json({ paths: [] });
    }

    // Get disk space info for each path
    const pathsWithInfo = await Promise.all(
      userDetails.storagePaths.map(async (storagePath) => {
        try {
          // Check if path exists
          if (!fs.existsSync(storagePath)) {
            return {
              path: storagePath,
              error: 'Path does not exist'
            };
          }

          // Get disk space using platform-specific commands
          const checkDiskSpace = require('check-disk-space').default;
          const diskSpace = await checkDiskSpace(storagePath);

          return {
            path: storagePath,
            totalSpace: diskSpace.size,
            freeSpace: diskSpace.free,
            usedSpace: diskSpace.size - diskSpace.free
          };
        } catch (error) {
          console.error(`Error checking space for ${storagePath}:`, error);
          return {
            path: storagePath,
            error: 'Unable to read disk space'
          };
        }
      })
    );

    res.json({ paths: pathsWithInfo });
  } catch (error) {
    console.error('Error fetching storage paths:', error);
    res.status(500).json({ error: 'Failed to fetch storage paths' });
  }
});

// Add storage path
router.post('/storage-paths', validateExternalToken, requireAdmin, async (req, res) => {
  try {
    const { path: storagePath } = req.body;

    if (!storagePath) {
      return res.status(400).json({ error: 'Storage path is required' });
    }

    // Validate path exists
    if (!fs.existsSync(storagePath)) {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    // Check if path is a directory
    const stats = fs.statSync(storagePath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Path must be a directory' });
    }

    // Check write permissions
    try {
      fs.accessSync(storagePath, fs.constants.W_OK);
    } catch (error) {
      return res.status(400).json({ error: 'No write permission for this path' });
    }

    const userDetails = await UserDetails.findOne({ externalUserId: req.user._id });

    // Initialize storagePaths if not exists
    if (!userDetails.storagePaths) {
      userDetails.storagePaths = [];
    }

    // Check if path already exists
    if (userDetails.storagePaths.includes(storagePath)) {
      return res.status(400).json({ error: 'Path already exists' });
    }

    // Add path
    userDetails.storagePaths.push(storagePath);
    await userDetails.save();

    // Get updated paths with disk space info
    const checkDiskSpace = require('check-disk-space').default;
    const pathsWithInfo = await Promise.all(
      userDetails.storagePaths.map(async (path) => {
        try {
          const diskSpace = await checkDiskSpace(path);
          return {
            path,
            totalSpace: diskSpace.size,
            freeSpace: diskSpace.free,
            usedSpace: diskSpace.size - diskSpace.free
          };
        } catch (error) {
          return {
            path,
            error: 'Unable to read disk space'
          };
        }
      })
    );

    res.json({ paths: pathsWithInfo });
  } catch (error) {
    console.error('Error adding storage path:', error);
    res.status(500).json({ error: 'Failed to add storage path' });
  }
});

// Remove storage path
router.delete('/storage-paths', validateExternalToken, requireAdmin, async (req, res) => {
  try {
    const { path: storagePath } = req.body;

    if (!storagePath) {
      return res.status(400).json({ error: 'Storage path is required' });
    }

    const userDetails = await UserDetails.findOne({ externalUserId: req.user._id });

    if (!userDetails.storagePaths || userDetails.storagePaths.length === 0) {
      return res.status(400).json({ error: 'No storage paths configured' });
    }

    // Remove path
    userDetails.storagePaths = userDetails.storagePaths.filter(p => p !== storagePath);
    await userDetails.save();

    // Get updated paths with disk space info
    const checkDiskSpace = require('check-disk-space').default;
    const pathsWithInfo = await Promise.all(
      userDetails.storagePaths.map(async (path) => {
        try {
          const diskSpace = await checkDiskSpace(path);
          return {
            path,
            totalSpace: diskSpace.size,
            freeSpace: diskSpace.free,
            usedSpace: diskSpace.size - diskSpace.free
          };
        } catch (error) {
          return {
            path,
            error: 'Unable to read disk space'
          };
        }
      })
    );

    res.json({ paths: pathsWithInfo });
  } catch (error) {
    console.error('Error removing storage path:', error);
    res.status(500).json({ error: 'Failed to remove storage path' });
  }
});

module.exports = router;
