const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const Share = require('../models/Share');
const File = require('../models/File');
const Folder = require('../models/Folder');

// Helper: get mime type from extension for system files
const getSystemMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mimeMap = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    pdf: 'application/pdf',
    txt: 'text/plain', html: 'text/html', css: 'text/css', csv: 'text/csv',
    json: 'application/json', xml: 'application/xml',
    js: 'text/javascript', ts: 'text/plain', py: 'text/plain',
    zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  return mimeMap[ext] || 'application/octet-stream';
};

const getSystemFileType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
  const videoExts = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  return 'other';
};

// NO authentication on these routes — public access

// Helper: validate share token
const getActiveShare = async (token) => {
  const share = await Share.findOne({
    publicToken: token,
    shareType: 'public',
    isActive: true
  });

  if (!share) return null;

  // Check expiry
  if (share.expiresAt && new Date() > share.expiresAt) {
    return null;
  }

  return share;
};

// GET /public/:token — Get public share metadata
router.get('/:token', async (req, res) => {
  try {
    const share = await getActiveShare(req.params.token);
    if (!share) {
      return res.status(404).json({ error: 'Share not found or expired' });
    }

    // System file/folder shares (path-based)
    if (share.itemType === 'system-file' || share.itemType === 'system-folder') {
      const exists = await fs.pathExists(share.itemPath);
      if (!exists) {
        return res.status(404).json({ error: 'Shared item no longer exists' });
      }

      const stat = await fs.stat(share.itemPath);
      const mimeType = stat.isFile() ? getSystemMimeType(share.itemPath) : null;
      const fileType = stat.isFile() ? getSystemFileType(share.itemPath) : null;

      return res.json({
        shareType: share.shareType,
        itemType: share.itemType,
        itemName: share.itemName,
        sharedBy: { name: share.sharedByName, email: share.sharedByEmail },
        sharedAt: share.createdAt,
        item: {
          name: share.itemName,
          mimeType,
          size: stat.isFile() ? stat.size : null,
          fileType
        }
      });
    }

    // DB file/folder shares
    let item = null;
    if (share.itemType === 'file') {
      item = await File.findById(share.itemId).select('originalName name mimeType size fileType createdAt');
    } else {
      item = await Folder.findById(share.itemId).select('name createdAt');
    }

    if (!item) {
      return res.status(404).json({ error: 'Shared item no longer exists' });
    }

    res.json({
      shareType: share.shareType,
      itemType: share.itemType,
      itemName: share.itemName || item.originalName || item.name,
      sharedBy: {
        name: share.sharedByName,
        email: share.sharedByEmail
      },
      sharedAt: share.createdAt,
      item: {
        _id: item._id,
        name: item.originalName || item.name,
        mimeType: item.mimeType,
        size: item.size,
        fileType: item.fileType
      }
    });
  } catch (error) {
    console.error('Public share info error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /public/:token/view — View/stream public file
router.get('/:token/view', async (req, res) => {
  try {
    const share = await getActiveShare(req.params.token);
    if (!share) {
      return res.status(404).json({ error: 'Share not found or expired' });
    }

    if (share.itemType !== 'file' && share.itemType !== 'system-file') {
      return res.status(400).json({ error: 'Can only view files' });
    }

    let filePath, mimeType, fileSize, fileType;

    if (share.itemType === 'system-file') {
      filePath = share.itemPath;
      const exists = await fs.pathExists(filePath);
      if (!exists) return res.status(404).json({ error: 'File not found on disk' });
      const stat = await fs.stat(filePath);
      fileSize = stat.size;
      mimeType = getSystemMimeType(filePath);
      fileType = getSystemFileType(filePath);
    } else {
      const file = await File.findById(share.itemId);
      if (!file) return res.status(404).json({ error: 'File no longer exists' });
      const exists = await fs.pathExists(file.path);
      if (!exists) return res.status(404).json({ error: 'File not found on disk' });
      filePath = file.path;
      mimeType = file.mimeType;
      fileSize = file.size;
      fileType = file.fileType;
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', fileSize);

    // Support range requests for videos
    if (fileType === 'video') {
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', chunksize);

        const stream = fs.createReadStream(filePath, { start, end });
        stream.pipe(res);
      } else {
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
      }
    } else {
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    }
  } catch (error) {
    console.error('Public view error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /public/:token/download — Download public file
router.get('/:token/download', async (req, res) => {
  try {
    const share = await getActiveShare(req.params.token);
    if (!share) {
      return res.status(404).json({ error: 'Share not found or expired' });
    }

    if (share.itemType !== 'file' && share.itemType !== 'system-file') {
      return res.status(400).json({ error: 'Can only download files' });
    }

    let filePath, fileName;

    if (share.itemType === 'system-file') {
      filePath = share.itemPath;
      fileName = path.basename(share.itemPath);
    } else {
      const file = await File.findById(share.itemId);
      if (!file) return res.status(404).json({ error: 'File no longer exists' });
      filePath = file.path;
      fileName = file.originalName;
    }

    const exists = await fs.pathExists(filePath);
    if (!exists) return res.status(404).json({ error: 'File not found on disk' });

    res.download(filePath, fileName);
  } catch (error) {
    console.error('Public download error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /public/:token/folder — Browse public shared folder contents
router.get('/:token/folder', async (req, res) => {
  try {
    const share = await getActiveShare(req.params.token);
    if (!share) {
      return res.status(404).json({ error: 'Share not found or expired' });
    }

    if (share.itemType !== 'folder') {
      return res.status(400).json({ error: 'Not a folder share' });
    }

    const { subfolder } = req.query; // optional: browse subfolder within shared folder
    const folderId = subfolder || share.itemId;

    // Verify subfolder is within shared folder tree
    if (subfolder) {
      const folder = await Folder.findById(subfolder);
      if (!folder) {
        return res.status(404).json({ error: 'Folder not found' });
      }
      // Walk up the tree to verify it's under the shared folder
      let current = folder;
      let isChild = false;
      while (current.parent) {
        if (current.parent.toString() === share.itemId.toString()) {
          isChild = true;
          break;
        }
        current = await Folder.findById(current.parent);
        if (!current) break;
      }
      if (current._id.toString() === share.itemId.toString()) isChild = true;
      if (!isChild) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const [folders, files] = await Promise.all([
      Folder.find({ parent: folderId }).select('name createdAt').sort({ name: 1 }),
      File.find({ folder: folderId }).select('originalName name mimeType size fileType createdAt').sort({ createdAt: -1 })
    ]);

    res.json({ folders, files });
  } catch (error) {
    console.error('Public folder browse error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
