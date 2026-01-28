const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const File = require('../models/File');
const Folder = require('../models/Folder');
const UserDetails = require('../models/UserDetails');
const validateExternalToken = require('../middleware/validateExternalToken');
const { extractMetadata } = require('../utils/metadataExtractor');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      // Get user details for storage path
      const userDetails = await UserDetails.findOne({ externalUserId: req.user._id });

      if (!userDetails) {
        return cb(new Error('User details not found'));
      }

      let uploadPath = path.join(userDetails.storagePath, req.user._id.toString());

      if (req.body.folderId) {
        const folder = await Folder.findOne({ _id: req.body.folderId, owner: req.user._id });
        if (folder) {
          uploadPath = folder.path;
        }
      }

      await fs.ensureDir(uploadPath);
      cb(null, uploadPath);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max file size (reasonable for mobile)
    files: 10 // Max 10 files at once
  }
});

// Get all files for current user with pagination
router.get('/', validateExternalToken, async (req, res) => {
  try {
    const { folder, page = 1, limit = 100 } = req.query;

    const query = { owner: req.user._id };

    if (folder) {
      query.folder = folder;
    } else {
      query.folder = null; // Root files
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count for pagination info
    const totalFiles = await File.countDocuments(query);

    // Get paginated files
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
    console.error('Get files error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Error handler middleware for multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size too large. Maximum size is 500MB per file.' });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Too many files. Maximum is 10 files at once.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  next(err);
};

// Upload files (multiple)
router.post('/upload', validateExternalToken, upload.array('files', 10), handleMulterError, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const { folderId } = req.body;

    // Calculate total size
    const totalSize = req.files.reduce((sum, file) => sum + file.size, 0);

    // Check storage quota
    if (!req.user.hasSpace(totalSize)) {
      // Delete uploaded files
      for (const file of req.files) {
        await fs.remove(file.path);
      }
      return res.status(400).json({ error: 'Not enough storage space' });
    }

    const uploadedFiles = [];

    for (const file of req.files) {
      // Check if file with same name already exists in the same folder
      const existingFile = await File.findOne({
        originalName: file.originalname,
        folder: folderId || null,
        owner: req.user._id
      });

      if (existingFile) {
        // Delete the uploaded file since it's a duplicate
        await fs.remove(file.path);
        continue; // Skip this file
      }

      const fileType = File.getFileType(file.mimetype);

      // Extract metadata from file
      const metadata = await extractMetadata(file.path, file.mimetype);

      const newFile = new File({
        name: file.filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        path: file.path,
        owner: req.user._id,
        folder: folderId || null,
        fileType,
        metadata
      });

      await newFile.save();
      uploadedFiles.push(newFile);
    }

    // Update user's used storage
    await UserDetails.findOneAndUpdate(
      { externalUserId: req.user._id },
      { $inc: { usedStorage: totalSize } }
    );

    res.status(201).json({
      message: 'Files uploaded successfully',
      files: uploadedFiles
    });
  } catch (error) {
    console.error('Upload error:', error);

    // Clean up uploaded files on error
    if (req.files) {
      for (const file of req.files) {
        await fs.remove(file.path).catch(() => {});
      }
    }

    res.status(500).json({ error: 'Server error during upload' });
  }
});

// Download file
router.get('/download/:fileId', validateExternalToken, async (req, res) => {
  try {
    const { fileId } = req.params;

    const file = await File.findOne({ _id: fileId, owner: req.user._id });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Check if file exists
    const exists = await fs.pathExists(file.path);
    if (!exists) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    res.download(file.path, file.originalName);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// View file (stream for videos, images, pdfs)
router.get('/view/:fileId', validateExternalToken, async (req, res) => {
  try {
    const { fileId } = req.params;

    const file = await File.findOne({ _id: fileId, owner: req.user._id });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Check if file exists
    const exists = await fs.pathExists(file.path);
    if (!exists) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    // Set appropriate headers
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', file.size);

    // For videos, support range requests
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

        const stream = fs.createReadStream(file.path, { start, end });
        stream.pipe(res);
      } else {
        res.setHeader('Content-Length', file.size);
        const stream = fs.createReadStream(file.path);
        stream.pipe(res);
      }
    } else {
      // For other files, just stream
      const stream = fs.createReadStream(file.path);
      stream.pipe(res);
    }
  } catch (error) {
    console.error('View file error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk move files
router.put('/bulk-move', validateExternalToken, async (req, res) => {
  try {
    const { fileIds, targetFolderId } = req.body;

    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ error: 'No files specified' });
    }

    // Get target folder path if provided
    let targetPath = path.join(req.user.storagePath, req.user._id.toString());
    if (targetFolderId) {
      const targetFolder = await Folder.findOne({ _id: targetFolderId, owner: req.user._id });
      if (!targetFolder) {
        return res.status(404).json({ error: 'Target folder not found' });
      }
      targetPath = targetFolder.path;
    }

    const movedFiles = [];

    for (const fileId of fileIds) {
      const file = await File.findOne({ _id: fileId, owner: req.user._id });
      if (!file) continue;

      const oldPath = file.path;
      const newPath = path.join(targetPath, file.name);

      // Move physical file
      await fs.move(oldPath, newPath, { overwrite: false });

      // Update database
      file.path = newPath;
      file.folder = targetFolderId || null;
      await file.save();

      movedFiles.push(file);
    }

    res.json({
      message: `${movedFiles.length} file(s) moved successfully`,
      files: movedFiles
    });
  } catch (error) {
    console.error('Bulk move error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk copy files
router.post('/bulk-copy', validateExternalToken, async (req, res) => {
  try {
    const { fileIds, targetFolderId } = req.body;

    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ error: 'No files specified' });
    }

    // Get target folder path if provided
    let targetPath = path.join(req.user.storagePath, req.user._id.toString());
    if (targetFolderId) {
      const targetFolder = await Folder.findOne({ _id: targetFolderId, owner: req.user._id });
      if (!targetFolder) {
        return res.status(404).json({ error: 'Target folder not found' });
      }
      targetPath = targetFolder.path;
    }

    const copiedFiles = [];
    let totalCopySize = 0;

    for (const fileId of fileIds) {
      const file = await File.findOne({ _id: fileId, owner: req.user._id });
      if (!file) continue;

      totalCopySize += file.size;
    }

    // Check storage quota
    if (!req.user.hasSpace(totalCopySize)) {
      return res.status(400).json({ error: 'Not enough storage space for copying' });
    }

    for (const fileId of fileIds) {
      const file = await File.findOne({ _id: fileId, owner: req.user._id });
      if (!file) continue;

      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const newFilename = uniqueSuffix + '-' + file.originalName;
      const newPath = path.join(targetPath, newFilename);

      // Copy physical file
      await fs.copy(file.path, newPath);

      // Create new database entry
      const newFile = new File({
        name: newFilename,
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: file.size,
        path: newPath,
        owner: req.user._id,
        folder: targetFolderId || null,
        fileType: file.fileType
      });

      await newFile.save();
      copiedFiles.push(newFile);
    }

    // Update user's used storage
    await UserDetails.findOneAndUpdate(
      { externalUserId: req.user._id },
      { $inc: { usedStorage: totalCopySize } }
    );

    res.json({
      message: `${copiedFiles.length} file(s) copied successfully`,
      files: copiedFiles
    });
  } catch (error) {
    console.error('Bulk copy error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete file
router.delete('/:fileId', validateExternalToken, async (req, res) => {
  try {
    const { fileId } = req.params;

    const file = await File.findOne({ _id: fileId, owner: req.user._id });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Delete physical file
    await fs.remove(file.path).catch(() => {});

    // Update user's used storage
    await UserDetails.findOneAndUpdate(
      { externalUserId: req.user._id },
      { $inc: { usedStorage: -file.size } }
    );

    // Delete from database
    await File.findByIdAndDelete(fileId);

    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
