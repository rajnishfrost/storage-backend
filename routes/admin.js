const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const UserDetails = require('../models/UserDetails');
const File = require('../models/File');
const Folder = require('../models/Folder');
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

// Browse server folders (for selecting storage paths)
router.get('/browse-folders', validateExternalToken, requireAdmin, async (req, res) => {
  try {
    let browsePath = req.query.path || '/';

    // Normalize path
    browsePath = path.resolve(browsePath);

    // Check if path exists
    if (!fs.existsSync(browsePath)) {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    // Check if it's a directory
    const stats = fs.statSync(browsePath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    // Read directory contents - only directories
    const entries = fs.readdirSync(browsePath, { withFileTypes: true });
    const folders = [];

    for (const entry of entries) {
      // Skip hidden files/folders (starting with .)
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        const fullPath = path.join(browsePath, entry.name);
        let writable = false;
        try {
          fs.accessSync(fullPath, fs.constants.W_OK);
          writable = true;
        } catch (e) {
          // Not writable
        }
        folders.push({
          name: entry.name,
          path: fullPath,
          writable
        });
      }
    }

    // Sort alphabetically
    folders.sort((a, b) => a.name.localeCompare(b.name));

    // Check if current path is writable
    let currentWritable = false;
    try {
      fs.accessSync(browsePath, fs.constants.W_OK);
      currentWritable = true;
    } catch (e) {
      // Not writable
    }

    res.json({
      currentPath: browsePath,
      parentPath: path.dirname(browsePath),
      isRoot: browsePath === path.dirname(browsePath),
      writable: currentWritable,
      folders
    });
  } catch (error) {
    console.error('Error browsing folders:', error);
    res.status(500).json({ error: 'Failed to browse folders' });
  }
});

// Create a new folder on the server
router.post('/create-folder', validateExternalToken, requireAdmin, async (req, res) => {
  try {
    const { parentPath, folderName } = req.body;

    if (!parentPath || !folderName) {
      return res.status(400).json({ error: 'Parent path and folder name are required' });
    }

    // Sanitize folder name - no path separators or special chars
    const sanitized = folderName.replace(/[/\\:*?"<>|]/g, '').trim();
    if (!sanitized) {
      return res.status(400).json({ error: 'Invalid folder name' });
    }

    const resolvedParent = path.resolve(parentPath);

    // Check parent exists and is writable
    if (!fs.existsSync(resolvedParent)) {
      return res.status(400).json({ error: 'Parent path does not exist' });
    }

    try {
      fs.accessSync(resolvedParent, fs.constants.W_OK);
    } catch (e) {
      return res.status(400).json({ error: 'No write permission on parent directory' });
    }

    const newFolderPath = path.join(resolvedParent, sanitized);

    if (fs.existsSync(newFolderPath)) {
      return res.status(400).json({ error: 'Folder already exists' });
    }

    fs.mkdirSync(newFolderPath, { recursive: true });

    res.json({ message: 'Folder created successfully', path: newFolderPath });
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// Delete a folder from the server
router.delete('/delete-folder', validateExternalToken, requireAdmin, async (req, res) => {
  try {
    const { folderPath } = req.body;

    if (!folderPath) {
      return res.status(400).json({ error: 'Folder path is required' });
    }

    const resolvedPath = path.resolve(folderPath);

    // Safety: prevent deleting root or critical system paths
    const dangerousPaths = ['/', '/bin', '/usr', '/etc', '/var', '/sys', '/proc', '/home', '/root', '/tmp'];
    if (dangerousPaths.includes(resolvedPath) || resolvedPath.split(path.sep).length <= 2) {
      return res.status(400).json({ error: 'Cannot delete system or root-level directories' });
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(400).json({ error: 'Folder does not exist' });
    }

    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    // Check write permission on parent
    const parentDir = path.dirname(resolvedPath);
    try {
      fs.accessSync(parentDir, fs.constants.W_OK);
    } catch (e) {
      return res.status(400).json({ error: 'No write permission on parent directory' });
    }

    fs.rmSync(resolvedPath, { recursive: true, force: true });

    res.json({ message: 'Folder deleted successfully' });
  } catch (error) {
    console.error('Error deleting folder:', error);
    res.status(500).json({ error: 'Failed to delete folder' });
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

// Get user's folders (admin view)
router.get('/user-folders/:userId', validateExternalToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { parent } = req.query;

    // userId here is UserDetails _id, get externalUserId
    const userDetails = await UserDetails.findById(userId);
    if (!userDetails) {
      return res.status(404).json({ error: 'User not found' });
    }

    const query = { owner: userDetails.externalUserId };
    if (parent) {
      query.parent = parent;
    } else {
      query.parent = null;
    }

    const folders = await Folder.find(query).sort({ createdAt: -1 });
    res.json(folders);
  } catch (error) {
    console.error('Error fetching user folders:', error);
    res.status(500).json({ error: 'Failed to fetch user folders' });
  }
});

// Get user's files (admin view) with pagination
router.get('/user-files/:userId', validateExternalToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { folder, page = 1, limit = 50 } = req.query;

    const userDetails = await UserDetails.findById(userId);
    if (!userDetails) {
      return res.status(404).json({ error: 'User not found' });
    }

    const query = { owner: userDetails.externalUserId };
    if (folder) {
      query.folder = folder;
    } else {
      query.folder = null;
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const totalFiles = await File.countDocuments(query);
    const files = await File.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({
      files,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalFiles / limitNum),
        totalFiles,
        hasMore: skip + files.length < totalFiles
      }
    });
  } catch (error) {
    console.error('Error fetching user files:', error);
    res.status(500).json({ error: 'Failed to fetch user files' });
  }
});

// View/stream any file (admin only) - same as /files/view but without owner check
router.get('/view-file/:fileId', validateExternalToken, requireAdmin, async (req, res) => {
  try {
    const { fileId } = req.params;
    const file = await File.findById(fileId);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (!fs.existsSync(file.path)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    res.setHeader('Content-Type', file.mimeType);

    if (file.fileType === 'video') {
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : file.size - 1;
        const chunksize = (end - start) + 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
        res.setHeader('Content-Length', chunksize);
        fs.createReadStream(file.path, { start, end }).pipe(res);
      } else {
        res.setHeader('Content-Length', file.size);
        fs.createReadStream(file.path).pipe(res);
      }
    } else {
      res.setHeader('Content-Length', file.size);
      fs.createReadStream(file.path).pipe(res);
    }
  } catch (error) {
    console.error('Admin view file error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Download file (admin only)
router.get('/download-file/:fileId', validateExternalToken, requireAdmin, async (req, res) => {
  try {
    const { fileId } = req.params;
    const file = await File.findById(fileId);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (!fs.existsSync(file.path)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', file.size);
    fs.createReadStream(file.path).pipe(res);
  } catch (error) {
    console.error('Admin download file error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
