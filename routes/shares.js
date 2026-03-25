const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Share = require('../models/Share');
const File = require('../models/File');
const Folder = require('../models/Folder');
const UserDetails = require('../models/UserDetails');
const fs = require('fs-extra');
const path = require('path');
const validateExternalToken = require('../middleware/validateExternalToken');
const { hasModule } = require('../middleware/auth');

const Role = require('../models/Role');

// All routes require authentication
router.use(validateExternalToken);

// GET /shares/search-users?q=... — Search users by email/name (only 'user' role)
router.get('/search-users', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.json([]);
    }

    const userRole = await Role.findOne({ name: 'user' });
    if (!userRole) return res.json([]);

    const users = await UserDetails.find({
      role: userRole._id,
      isActive: true,
      externalUserId: { $ne: req.user._id }, // exclude self
      $or: [
        { email: { $regex: q, $options: 'i' } },
        { name: { $regex: q, $options: 'i' } }
      ]
    })
    .select('name email')
    .limit(10);

    res.json(users.map(u => ({ name: u.name, email: u.email })));
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Helper: validate item exists and user owns it
const validateOwnership = async (itemId, itemType, userId) => {
  if (itemType === 'file') {
    return await File.findOne({ _id: itemId, owner: userId });
  } else {
    return await Folder.findOne({ _id: itemId, owner: userId });
  }
};

// POST /shares/private — Share with specific users by email
router.post('/private', async (req, res) => {
  try {
    const { itemId, itemType, emails, accessType = 'view' } = req.body;

    if (!itemId || !itemType || !emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'itemId, itemType, and emails array are required' });
    }

    // Validate item ownership
    const item = await validateOwnership(itemId, itemType, req.user._id);
    if (!item) {
      return res.status(404).json({ error: 'Item not found or you do not own it' });
    }

    const itemName = item.originalName || item.name;

    // Resolve emails to userIds where possible
    const sharedWith = [];
    for (const email of emails) {
      const userDetail = await UserDetails.findOne({ email: email.trim().toLowerCase() });
      sharedWith.push({
        email: email.trim().toLowerCase(),
        userId: userDetail ? userDetail.externalUserId : null,
        accessType
      });
    }

    // Check if private share already exists for this item by this user
    let share = await Share.findOne({
      itemId, itemType, sharedBy: req.user._id, shareType: 'private', isActive: true
    });

    if (share) {
      // Merge new emails (avoid duplicates)
      for (const sw of sharedWith) {
        const exists = share.sharedWith.find(s => s.email === sw.email);
        if (!exists) {
          share.sharedWith.push(sw);
        } else {
          exists.accessType = sw.accessType;
          if (sw.userId) exists.userId = sw.userId;
        }
      }
      share.itemName = itemName;
      await share.save();
    } else {
      share = await Share.create({
        itemId,
        itemType,
        itemName,
        sharedBy: req.user._id,
        sharedByName: req.user.name,
        sharedByEmail: req.user.email,
        shareType: 'private',
        sharedWith
      });
    }

    res.status(201).json(share);
  } catch (error) {
    console.error('Private share error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /shares/public — Generate public link
router.post('/public', async (req, res) => {
  try {
    const { itemId, itemType } = req.body;

    if (!itemId || !itemType) {
      return res.status(400).json({ error: 'itemId and itemType are required' });
    }

    const item = await validateOwnership(itemId, itemType, req.user._id);
    if (!item) {
      return res.status(404).json({ error: 'Item not found or you do not own it' });
    }

    const itemName = item.originalName || item.name;

    // Check if public share already exists
    let share = await Share.findOne({
      itemId, itemType, sharedBy: req.user._id, shareType: 'public', isActive: true
    });

    if (share) {
      return res.json(share);
    }

    const publicToken = uuidv4();

    share = await Share.create({
      itemId,
      itemType,
      itemName,
      sharedBy: req.user._id,
      sharedByName: req.user.name,
      sharedByEmail: req.user.email,
      shareType: 'public',
      publicToken
    });

    res.status(201).json(share);
  } catch (error) {
    console.error('Public share error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /shares/shared-with-me — Items shared with current user
router.get('/shared-with-me', async (req, res) => {
  try {
    const userEmail = req.user.email?.toLowerCase();
    const userId = req.user._id;

    const shares = await Share.find({
      isActive: true,
      shareType: 'private',
      $or: [
        { 'sharedWith.email': userEmail },
        { 'sharedWith.userId': userId }
      ]
    }).sort({ createdAt: -1 });

    // Enrich with item details
    const enriched = [];
    for (const share of shares) {
      // Find this user's access type
      const myAccess = share.sharedWith.find(
        s => s.email === userEmail || s.userId === userId
      );

      // System file/folder shares (path-based, no DB entry)
      if (share.itemType === 'system-file' || share.itemType === 'system-folder') {
        // Detect file type from extension
        let sysFileType = 'other';
        let sysMimeType = null;
        let sysSize = null;
        if (share.itemType === 'system-file' && share.itemPath) {
          const ext = path.extname(share.itemPath).toLowerCase().slice(1);
          const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
          const vidExts = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
          const audExts = ['mp3', 'wav', 'ogg', 'm4a'];
          if (imgExts.includes(ext)) sysFileType = 'image';
          else if (vidExts.includes(ext)) sysFileType = 'video';
          else if (audExts.includes(ext)) sysFileType = 'audio';
          else if (ext === 'pdf') sysFileType = 'pdf';
          sysMimeType = getSystemMimeType(share.itemPath);
          try {
            const stat = await fs.stat(share.itemPath);
            sysSize = stat.size;
          } catch (e) { /* file may not be accessible */ }
        } else if (share.itemType === 'system-folder') {
          sysFileType = 'folder';
        }

        enriched.push({
          _id: share._id,
          itemId: null,
          itemPath: share.itemPath,
          itemType: share.itemType,
          itemName: share.itemName,
          sharedBy: {
            name: share.sharedByName,
            email: share.sharedByEmail
          },
          accessType: myAccess?.accessType || 'view',
          sharedAt: share.createdAt,
          item: {
            name: share.itemName,
            mimeType: sysMimeType,
            size: sysSize,
            fileType: sysFileType
          }
        });
        continue;
      }

      // DB file/folder shares
      let item = null;
      if (share.itemType === 'file') {
        item = await File.findById(share.itemId).select('originalName name mimeType size fileType createdAt');
      } else if (share.itemType === 'folder') {
        item = await Folder.findById(share.itemId).select('name createdAt');
      }

      if (item) {
        enriched.push({
          _id: share._id,
          itemId: share.itemId,
          itemType: share.itemType,
          itemName: share.itemName || item.originalName || item.name,
          sharedBy: {
            name: share.sharedByName,
            email: share.sharedByEmail
          },
          accessType: myAccess?.accessType || 'view',
          sharedAt: share.createdAt,
          item: {
            name: item.originalName || item.name,
            mimeType: item.mimeType,
            size: item.size,
            fileType: item.fileType
          }
        });
      }
    }

    res.json(enriched);
  } catch (error) {
    console.error('Shared with me error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /shares/my-shares — Items I've shared
router.get('/my-shares', async (req, res) => {
  try {
    const shares = await Share.find({
      sharedBy: req.user._id,
      isActive: true
    }).sort({ createdAt: -1 });

    res.json(shares);
  } catch (error) {
    console.error('My shares error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /shares/item/:itemType/:itemId — Get share info for a specific item
router.get('/item/:itemType/:itemId', async (req, res) => {
  try {
    const { itemType, itemId } = req.params;

    const shares = await Share.find({
      itemId,
      itemType,
      sharedBy: req.user._id,
      isActive: true
    });

    res.json(shares);
  } catch (error) {
    console.error('Get item shares error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /shares/:shareId — Revoke/delete a share
router.delete('/:shareId', async (req, res) => {
  try {
    const share = await Share.findOne({
      _id: req.params.shareId,
      sharedBy: req.user._id
    });

    if (!share) {
      return res.status(404).json({ error: 'Share not found' });
    }

    await Share.findByIdAndDelete(share._id);
    res.json({ message: 'Share deleted successfully' });
  } catch (error) {
    console.error('Delete share error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /shares/:shareId/remove-user — Remove a user from private share
router.patch('/:shareId/remove-user', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const share = await Share.findOne({
      _id: req.params.shareId,
      sharedBy: req.user._id,
      shareType: 'private'
    });

    if (!share) {
      return res.status(404).json({ error: 'Share not found' });
    }

    share.sharedWith = share.sharedWith.filter(s => s.email !== email.trim().toLowerCase());

    // If no users left, delete the share
    if (share.sharedWith.length === 0) {
      await Share.findByIdAndDelete(share._id);
      return res.json({ message: 'Share deleted (no users remaining)' });
    }

    await share.save();
    res.json(share);
  } catch (error) {
    console.error('Remove user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== SHARED FILE VIEW/DOWNLOAD (for recipients) ==========

// Helper: get mime type from extension
const getSystemMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mimeMap = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    pdf: 'application/pdf', txt: 'text/plain', json: 'application/json',
    html: 'text/html', css: 'text/css', csv: 'text/csv'
  };
  return mimeMap[ext] || 'application/octet-stream';
};

// GET /shares/view/:shareId — View/stream a shared file (works for both DB and system files)
router.get('/view/:shareId', async (req, res) => {
  try {
    const userEmail = req.user.email?.toLowerCase();
    const userId = req.user._id;

    const share = await Share.findOne({
      _id: req.params.shareId,
      isActive: true,
      $or: [
        { 'sharedWith.email': userEmail },
        { 'sharedWith.userId': userId },
        { sharedBy: userId } // owner can also view
      ]
    });

    if (!share) {
      return res.status(404).json({ error: 'Share not found or access denied' });
    }

    let filePath, mimeType, fileSize;

    if (share.itemType === 'system-file') {
      filePath = share.itemPath;
      mimeType = getSystemMimeType(filePath);
      const stat = await fs.stat(filePath);
      fileSize = stat.size;
    } else if (share.itemType === 'file') {
      const File = require('../models/File');
      const file = await File.findById(share.itemId);
      if (!file) return res.status(404).json({ error: 'File not found' });
      filePath = file.path;
      mimeType = file.mimeType;
      fileSize = file.size;
    } else {
      return res.status(400).json({ error: 'Cannot view folders' });
    }

    const exists = await fs.pathExists(filePath);
    if (!exists) return res.status(404).json({ error: 'File not found on disk' });

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', fileSize);

    // Range requests for videos
    if (mimeType.startsWith('video/')) {
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', chunksize);
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        fs.createReadStream(filePath).pipe(res);
      }
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    console.error('Share view error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /shares/download/:shareId — Download a shared file
router.get('/download/:shareId', async (req, res) => {
  try {
    const userEmail = req.user.email?.toLowerCase();
    const userId = req.user._id;

    const share = await Share.findOne({
      _id: req.params.shareId,
      isActive: true,
      $or: [
        { 'sharedWith.email': userEmail },
        { 'sharedWith.userId': userId },
        { sharedBy: userId }
      ]
    });

    if (!share) {
      return res.status(404).json({ error: 'Share not found or access denied' });
    }

    let filePath, fileName;

    if (share.itemType === 'system-file') {
      filePath = share.itemPath;
      fileName = path.basename(share.itemPath);
    } else if (share.itemType === 'file') {
      const File = require('../models/File');
      const file = await File.findById(share.itemId);
      if (!file) return res.status(404).json({ error: 'File not found' });
      filePath = file.path;
      fileName = file.originalName;
    } else {
      return res.status(400).json({ error: 'Cannot download folders' });
    }

    const exists = await fs.pathExists(filePath);
    if (!exists) return res.status(404).json({ error: 'File not found on disk' });

    res.download(filePath, fileName);
  } catch (error) {
    console.error('Share download error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /shares/shared-files — Get all shared file items for the current user (for navigation)
router.get('/shared-files', async (req, res) => {
  try {
    const userEmail = req.user.email?.toLowerCase();
    const userId = req.user._id;

    const shares = await Share.find({
      isActive: true,
      shareType: 'private',
      itemType: { $in: ['file', 'system-file'] },
      $or: [
        { 'sharedWith.email': userEmail },
        { 'sharedWith.userId': userId }
      ]
    }).sort({ createdAt: -1 });

    res.json(shares.map(s => ({
      _id: s._id,
      itemType: s.itemType,
      itemName: s.itemName,
      itemPath: s.itemPath
    })));
  } catch (error) {
    console.error('Shared files error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== SYSTEM STORAGE SHARES (admin SS Management) ==========

// POST /shares/system/public — Share system file/folder via public link
router.post('/system/public', hasModule('ss-management'), async (req, res) => {
  try {
    const { itemPath, itemType } = req.body;

    if (!itemPath || !itemType) {
      return res.status(400).json({ error: 'itemPath and itemType are required' });
    }

    // Verify path exists
    const exists = await fs.pathExists(itemPath);
    if (!exists) {
      return res.status(404).json({ error: 'Path not found on filesystem' });
    }

    const itemName = path.basename(itemPath);

    // Check if public share already exists for this path
    let share = await Share.findOne({
      itemPath, shareType: 'public', sharedBy: req.user._id, isActive: true
    });

    if (share) {
      return res.json(share);
    }

    const publicToken = uuidv4();

    share = await Share.create({
      itemType,
      itemPath,
      itemName,
      sharedBy: req.user._id,
      sharedByName: req.user.name,
      sharedByEmail: req.user.email,
      shareType: 'public',
      publicToken
    });

    res.status(201).json(share);
  } catch (error) {
    console.error('System public share error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /shares/system/private — Share system file/folder with specific users
router.post('/system/private', hasModule('ss-management'), async (req, res) => {
  try {
    const { itemPath, itemType, emails, accessType = 'view' } = req.body;

    if (!itemPath || !itemType || !emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'itemPath, itemType, and emails are required' });
    }

    const exists = await fs.pathExists(itemPath);
    if (!exists) {
      return res.status(404).json({ error: 'Path not found on filesystem' });
    }

    const itemName = path.basename(itemPath);

    const sharedWith = [];
    for (const email of emails) {
      const userDetail = await UserDetails.findOne({ email: email.trim().toLowerCase() });
      sharedWith.push({
        email: email.trim().toLowerCase(),
        userId: userDetail ? userDetail.externalUserId : null,
        accessType
      });
    }

    let share = await Share.findOne({
      itemPath, shareType: 'private', sharedBy: req.user._id, isActive: true
    });

    if (share) {
      for (const sw of sharedWith) {
        const existing = share.sharedWith.find(s => s.email === sw.email);
        if (!existing) {
          share.sharedWith.push(sw);
        } else {
          existing.accessType = sw.accessType;
          if (sw.userId) existing.userId = sw.userId;
        }
      }
      share.itemName = itemName;
      await share.save();
    } else {
      share = await Share.create({
        itemType,
        itemPath,
        itemName,
        sharedBy: req.user._id,
        sharedByName: req.user.name,
        sharedByEmail: req.user.email,
        shareType: 'private',
        sharedWith
      });
    }

    res.status(201).json(share);
  } catch (error) {
    console.error('System private share error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /shares/system/item — Get share info for a system path
router.get('/system/item', hasModule('ss-management'), async (req, res) => {
  try {
    const { itemPath } = req.query;
    if (!itemPath) {
      return res.status(400).json({ error: 'itemPath is required' });
    }

    const shares = await Share.find({
      itemPath,
      sharedBy: req.user._id,
      isActive: true
    });

    res.json(shares);
  } catch (error) {
    console.error('Get system shares error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
