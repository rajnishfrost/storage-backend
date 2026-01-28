const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const Folder = require('../models/Folder');
const File = require('../models/File');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');

// Get all folders for current user (all folders regardless of parent)
router.get('/all', authenticate, async (req, res) => {
  try {
    const folders = await Folder.find({ owner: req.userId }).sort({ name: 1 });
    res.json(folders);
  } catch (error) {
    console.error('Get all folders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all folders for current user
router.get('/', authenticate, async (req, res) => {
  try {
    const { parent } = req.query;

    const query = { owner: req.userId };

    if (parent) {
      query.parent = parent;
    } else {
      query.parent = null; // Root folders
    }

    const folders = await Folder.find(query).sort({ createdAt: -1 });

    res.json(folders);
  } catch (error) {
    console.error('Get folders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new folder
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, parent } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    // Check if folder already exists with same name in same parent
    const existingFolder = await Folder.findOne({
      name,
      parent: parent || null,
      owner: req.userId
    });

    if (existingFolder) {
      return res.status(400).json({ error: 'Folder with this name already exists' });
    }

    // Create folder path
    let folderPath = path.join(req.user.storagePath, req.userId.toString());

    if (parent) {
      const parentFolder = await Folder.findOne({ _id: parent, owner: req.userId });
      if (!parentFolder) {
        return res.status(404).json({ error: 'Parent folder not found' });
      }
      folderPath = path.join(parentFolder.path, name);
    } else {
      folderPath = path.join(folderPath, name);
    }

    // Create physical folder
    await fs.ensureDir(folderPath);

    // Create folder in database
    const folder = new Folder({
      name,
      owner: req.userId,
      parent: parent || null,
      path: folderPath
    });

    await folder.save();

    res.status(201).json(folder);
  } catch (error) {
    console.error('Create folder error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Recursive function to delete folder and all its contents
async function deleteFolderRecursive(folderId, userId) {
  // Get all subfolders
  const subfolders = await Folder.find({ parent: folderId, owner: userId });

  // Recursively delete subfolders
  for (const subfolder of subfolders) {
    await deleteFolderRecursive(subfolder._id, userId);
  }

  // Get all files in this folder
  const files = await File.find({ folder: folderId, owner: userId });

  // Delete all files (both from disk and database)
  let totalSize = 0;
  for (const file of files) {
    totalSize += file.size;
    await fs.remove(file.path).catch(() => {}); // Delete physical file
    await File.findByIdAndDelete(file._id); // Delete from database
  }

  // Get the folder
  const folder = await Folder.findById(folderId);

  if (folder) {
    // Delete physical folder
    await fs.remove(folder.path);

    // Delete folder from database
    await Folder.findByIdAndDelete(folderId);
  }

  return totalSize;
}

// Helper function to update subfolder and file paths after rename
async function updateSubfolderPaths(folderId, oldPath, newPath) {
  // Update all subfolders
  const subfolders = await Folder.find({ parent: folderId });
  for (const subfolder of subfolders) {
    const subfolderOldPath = subfolder.path;
    const subfolderNewPath = subfolderOldPath.replace(oldPath, newPath);
    subfolder.path = subfolderNewPath;
    await subfolder.save();

    // Recursively update subfolders
    await updateSubfolderPaths(subfolder._id, subfolderOldPath, subfolderNewPath);
  }

  // Update all files in this folder
  const files = await File.find({ folder: folderId });
  for (const file of files) {
    file.path = file.path.replace(oldPath, newPath);
    await file.save();
  }
}

// Rename folder
router.put('/:folderId/rename', authenticate, async (req, res) => {
  try {
    const { folderId } = req.params;
    const { newName } = req.body;

    if (!newName || !newName.trim()) {
      return res.status(400).json({ error: 'New folder name is required' });
    }

    const folder = await Folder.findOne({ _id: folderId, owner: req.userId });

    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // Check if folder with same name already exists in the same parent
    const existingFolder = await Folder.findOne({
      name: newName.trim(),
      parent: folder.parent,
      owner: req.userId,
      _id: { $ne: folderId } // Exclude current folder
    });

    if (existingFolder) {
      return res.status(400).json({ error: 'Folder with this name already exists in this location' });
    }

    // Get old path and create new path
    const oldPath = folder.path;
    const parentPath = path.dirname(oldPath);
    const newPath = path.join(parentPath, newName.trim());

    // Rename physical folder
    await fs.rename(oldPath, newPath);

    // Update folder in database
    folder.name = newName.trim();
    folder.path = newPath;
    await folder.save();

    // Update all subfolder and file paths
    await updateSubfolderPaths(folderId, oldPath, newPath);

    res.json(folder);
  } catch (error) {
    console.error('Rename folder error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete folder
router.delete('/:folderId', authenticate, async (req, res) => {
  try {
    const { folderId } = req.params;

    const folder = await Folder.findOne({ _id: folderId, owner: req.userId });

    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // Recursively delete folder and all its contents
    const deletedSize = await deleteFolderRecursive(folderId, req.userId);

    // Update user's used storage
    if (deletedSize > 0) {
      await User.findByIdAndUpdate(req.userId, {
        $inc: { usedStorage: -deletedSize }
      });
    }

    res.json({ message: 'Folder deleted successfully' });
  } catch (error) {
    console.error('Delete folder error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk move folders
router.put('/bulk-move', authenticate, async (req, res) => {
  try {
    const { folderIds, targetFolderId } = req.body;

    if (!folderIds || !Array.isArray(folderIds) || folderIds.length === 0) {
      return res.status(400).json({ error: 'No folders specified' });
    }

    // Get target folder path if provided
    let targetPath = path.join(req.user.storagePath, req.userId.toString());
    if (targetFolderId) {
      const targetFolder = await Folder.findOne({ _id: targetFolderId, owner: req.userId });
      if (!targetFolder) {
        return res.status(404).json({ error: 'Target folder not found' });
      }
      targetPath = targetFolder.path;
    }

    const movedFolders = [];

    for (const folderId of folderIds) {
      const folder = await Folder.findOne({ _id: folderId, owner: req.userId });
      if (!folder) continue;

      // Prevent moving folder into itself or its subfolders
      if (folderId === targetFolderId) continue;

      const oldPath = folder.path;
      const newPath = path.join(targetPath, folder.name);

      // Move physical folder
      await fs.move(oldPath, newPath, { overwrite: false });

      // Update database
      folder.path = newPath;
      folder.parent = targetFolderId || null;
      await folder.save();

      movedFolders.push(folder);
    }

    res.json({
      message: `${movedFolders.length} folder(s) moved successfully`,
      folders: movedFolders
    });
  } catch (error) {
    console.error('Bulk move folders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk copy folders
router.post('/bulk-copy', authenticate, async (req, res) => {
  try {
    const { folderIds, targetFolderId } = req.body;

    if (!folderIds || !Array.isArray(folderIds) || folderIds.length === 0) {
      return res.status(400).json({ error: 'No folders specified' });
    }

    // Get target folder path if provided
    let targetPath = path.join(req.user.storagePath, req.userId.toString());
    if (targetFolderId) {
      const targetFolder = await Folder.findOne({ _id: targetFolderId, owner: req.userId });
      if (!targetFolder) {
        return res.status(404).json({ error: 'Target folder not found' });
      }
      targetPath = targetFolder.path;
    }

    const copiedFolders = [];

    for (const folderId of folderIds) {
      const folder = await Folder.findOne({ _id: folderId, owner: req.userId });
      if (!folder) continue;

      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const newFolderName = uniqueSuffix + '-' + folder.name;
      const newPath = path.join(targetPath, newFolderName);

      // Copy physical folder
      await fs.copy(folder.path, newPath);

      // Create new database entry
      const newFolder = new Folder({
        name: newFolderName,
        owner: req.userId,
        parent: targetFolderId || null,
        path: newPath
      });

      await newFolder.save();
      copiedFolders.push(newFolder);
    }

    res.json({
      message: `${copiedFolders.length} folder(s) copied successfully`,
      folders: copiedFolders
    });
  } catch (error) {
    console.error('Bulk copy folders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
