const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const checkDiskSpace = require('check-disk-space').default;
const validateExternalToken = require('../middleware/validateExternalToken');
const { isSuperAdmin, hasModule } = require('../middleware/auth');

const { execSync } = require('child_process');

// All routes require ss-management module access
router.use(validateExternalToken, hasModule('ss-management'));

// Get all mounted drives/partitions
router.get('/drives', async (req, res) => {
  try {
    // Use df command to get all mounted filesystems
    const output = execSync("df -B1 --output=source,fstype,size,used,avail,target 2>/dev/null || df -k 2>/dev/null", { encoding: 'utf-8' });
    const lines = output.trim().split('\n');
    const drives = [];

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length >= 6) {
        const source = parts[0];
        const fstype = parts[1];
        const size = parseInt(parts[2]) || 0;
        const used = parseInt(parts[3]) || 0;
        const available = parseInt(parts[4]) || 0;
        const mountPoint = parts.slice(5).join(' ');

        // Filter: only real drives (skip snap, boot/efi, loop devices)
        const isRealDrive = (source.startsWith('/dev/') || source.startsWith('//'))
          && !source.startsWith('/dev/loop')
          && !mountPoint.startsWith('/snap/')
          && !mountPoint.startsWith('/boot/');

        if (isRealDrive) {
          const displayName = mountPoint === '/'
            ? 'System (/)'
            : mountPoint.split('/').pop() || mountPoint;

          drives.push({
            device: source,
            fstype,
            size,
            used,
            free: available,
            mountPoint,
            name: displayName
          });
        }
      }
    }

    // Calculate combined totals
    const totalSize = drives.reduce((sum, d) => sum + d.size, 0);
    const totalUsed = drives.reduce((sum, d) => sum + d.used, 0);
    const totalFree = drives.reduce((sum, d) => sum + d.free, 0);

    res.json({
      drives,
      combined: {
        size: totalSize,
        used: totalUsed,
        free: totalFree
      }
    });
  } catch (error) {
    console.error('Drives info error:', error);
    res.status(500).json({ error: 'Failed to get drives info' });
  }
});

// Get disk info for a specific path
router.get('/disk-info', async (req, res) => {
  try {
    const targetPath = req.query.path || '/';
    const diskSpace = await checkDiskSpace(targetPath);

    res.json({
      free: diskSpace.free,
      size: diskSpace.size,
      used: diskSpace.size - diskSpace.free
    });
  } catch (error) {
    console.error('Disk info error:', error);
    res.status(500).json({ error: 'Failed to get disk info' });
  }
});

// Browse directory
router.get('/browse', async (req, res) => {
  try {
    const targetPath = req.query.path || '/';
    const resolvedPath = path.resolve(targetPath);

    // Check if path exists
    const exists = await fs.pathExists(resolvedPath);
    if (!exists) {
      return res.status(404).json({ error: 'Path not found' });
    }

    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      // Skip hidden system files that cause permission errors
      if (entry.name.startsWith('.')) continue;

      try {
        const fullPath = path.join(resolvedPath, entry.name);
        const entryStat = await fs.stat(fullPath);

        items.push({
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          size: entry.isDirectory() ? null : entryStat.size,
          modified: entryStat.mtime,
          created: entryStat.birthtime
        });
      } catch (err) {
        // Skip entries we can't read (permission denied)
        items.push({
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          isDirectory: entry.isDirectory(),
          size: null,
          modified: null,
          created: null,
          error: 'Permission denied'
        });
      }
    }

    // Sort: directories first, then by name
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({
      currentPath: resolvedPath,
      parentPath: path.dirname(resolvedPath),
      items
    });
  } catch (error) {
    console.error('Browse error:', error);
    if (error.code === 'EACCES') {
      return res.status(403).json({ error: 'Permission denied' });
    }
    res.status(500).json({ error: 'Failed to browse directory' });
  }
});

// View/download file
router.get('/view', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    const resolvedPath = path.resolve(filePath);
    const exists = await fs.pathExists(resolvedPath);
    if (!exists) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Cannot view a directory' });
    }

    // Determine MIME type
    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
      '.txt': 'text/plain', '.log': 'text/plain', '.csv': 'text/csv',
      '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
      '.json': 'application/json', '.xml': 'application/xml',
      '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    };

    const mimeType = mimeTypes[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);

    // Support range requests for video/audio
    const range = req.headers.range;
    if (range && (mimeType.startsWith('video/') || mimeType.startsWith('audio/'))) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', chunksize);
      res.setHeader('Accept-Ranges', 'bytes');

      const stream = fs.createReadStream(resolvedPath, { start, end });
      stream.pipe(res);
    } else {
      const stream = fs.createReadStream(resolvedPath);
      stream.pipe(res);
    }
  } catch (error) {
    console.error('View file error:', error);
    if (error.code === 'EACCES') {
      return res.status(403).json({ error: 'Permission denied' });
    }
    res.status(500).json({ error: 'Failed to view file' });
  }
});

// Download file
router.get('/download', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    const resolvedPath = path.resolve(filePath);
    const exists = await fs.pathExists(resolvedPath);
    if (!exists) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Cannot download a directory' });
    }

    const fileName = path.basename(resolvedPath);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'application/octet-stream');

    const stream = fs.createReadStream(resolvedPath);
    stream.pipe(res);
  } catch (error) {
    console.error('Download error:', error);
    if (error.code === 'EACCES') {
      return res.status(403).json({ error: 'Permission denied' });
    }
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// Delete file or folder
router.delete('/delete', async (req, res) => {
  try {
    const targetPath = req.body.path;
    if (!targetPath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    const resolvedPath = path.resolve(targetPath);

    // Safety: prevent deleting critical system paths
    const protectedPaths = ['/', '/bin', '/sbin', '/usr', '/etc', '/var', '/tmp', '/home', '/root', '/System', '/Library'];
    if (protectedPaths.includes(resolvedPath)) {
      return res.status(403).json({ error: 'Cannot delete protected system path' });
    }

    const exists = await fs.pathExists(resolvedPath);
    if (!exists) {
      return res.status(404).json({ error: 'Path not found' });
    }

    await fs.remove(resolvedPath);

    res.json({ message: 'Deleted successfully', path: resolvedPath });
  } catch (error) {
    console.error('Delete error:', error);
    if (error.code === 'EACCES') {
      return res.status(403).json({ error: 'Permission denied' });
    }
    res.status(500).json({ error: 'Failed to delete' });
  }
});

module.exports = router;
