const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const Folder = require('../models/Folder');
const File = require('../models/File');
const UserDetails = require('../models/UserDetails');
const Share = require('../models/Share');
const validateExternalToken = require('../middleware/validateExternalToken');

// Get all folders for current user (all folders regardless of parent)
router.get('/all', validateExternalToken, async (req, res) => {
  try {
    const folders = await Folder.find({ owner: req.user._id }).sort({ name: 1 });
    res.json(folders);
  } catch (error) {
    console.error('Get all folders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all folders for current user
router.get('/', validateExternalToken, async (req, res) => {
  try {
    const { parent } = req.query;

    const query = { owner: req.user._id };

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
router.post('/', validateExternalToken, async (req, res) => {
  try {
    const { name, parent } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    // Check if folder already exists with same name in same parent
    const existingFolder = await Folder.findOne({
      name,
      parent: parent || null,
      owner: req.user._id
    });

    if (existingFolder) {
      return res.status(400).json({ error: 'Folder with this name already exists' });
    }

    // Get user details for storage path
    const userDetails = await UserDetails.findOne({ externalUserId: req.user._id });
    if (!userDetails) {
      return res.status(404).json({ error: 'User details not found' });
    }

    // Create folder path
    let folderPath = path.join(userDetails.storagePath, req.user._id.toString());

    if (parent) {
      const parentFolder = await Folder.findOne({ _id: parent, owner: req.user._id });
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
      owner: req.user._id,
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
router.put('/:folderId/rename', validateExternalToken, async (req, res) => {
  try {
    const { folderId } = req.params;
    const { newName } = req.body;

    if (!newName || !newName.trim()) {
      return res.status(400).json({ error: 'New folder name is required' });
    }

    const folder = await Folder.findOne({ _id: folderId, owner: req.user._id });

    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // Check if folder with same name already exists in the same parent
    const existingFolder = await Folder.findOne({
      name: newName.trim(),
      parent: folder.parent,
      owner: req.user._id,
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
router.delete('/:folderId', validateExternalToken, async (req, res) => {
  try {
    const { folderId } = req.params;

    const folder = await Folder.findOne({ _id: folderId, owner: req.user._id });

    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // Recursively delete folder and all its contents
    const deletedSize = await deleteFolderRecursive(folderId, req.user._id);

    // Update user's used storage
    if (deletedSize > 0) {
      await UserDetails.findOneAndUpdate(
        { externalUserId: req.user._id },
        { $inc: { usedStorage: -deletedSize } }
      );
    }

    res.json({ message: 'Folder deleted successfully' });
  } catch (error) {
    console.error('Delete folder error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk move folders
router.put('/bulk-move', validateExternalToken, async (req, res) => {
  try {
    const { folderIds, targetFolderId } = req.body;

    if (!folderIds || !Array.isArray(folderIds) || folderIds.length === 0) {
      return res.status(400).json({ error: 'No folders specified' });
    }

    // Get user details for storage path
    const userDetails = await UserDetails.findOne({ externalUserId: req.user._id });
    if (!userDetails) {
      return res.status(404).json({ error: 'User details not found' });
    }

    // Get target folder path if provided
    let targetPath = path.join(userDetails.storagePath, req.user._id.toString());
    if (targetFolderId) {
      const targetFolder = await Folder.findOne({ _id: targetFolderId, owner: req.user._id });
      if (!targetFolder) {
        return res.status(404).json({ error: 'Target folder not found' });
      }
      targetPath = targetFolder.path;
    }

    const movedFolders = [];

    for (const folderId of folderIds) {
      const folder = await Folder.findOne({ _id: folderId, owner: req.user._id });
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
router.post('/bulk-copy', validateExternalToken, async (req, res) => {
  try {
    const { folderIds, targetFolderId } = req.body;

    if (!folderIds || !Array.isArray(folderIds) || folderIds.length === 0) {
      return res.status(400).json({ error: 'No folders specified' });
    }

    // Get user details for storage path
    const userDetails = await UserDetails.findOne({ externalUserId: req.user._id });
    if (!userDetails) {
      return res.status(404).json({ error: 'User details not found' });
    }

    // Get target folder path if provided
    let targetPath = path.join(userDetails.storagePath, req.user._id.toString());
    if (targetFolderId) {
      const targetFolder = await Folder.findOne({ _id: targetFolderId, owner: req.user._id });
      if (!targetFolder) {
        return res.status(404).json({ error: 'Target folder not found' });
      }
      targetPath = targetFolder.path;
    }

    const copiedFolders = [];

    for (const folderId of folderIds) {
      const folder = await Folder.findOne({ _id: folderId, owner: req.user._id });
      if (!folder) continue;

      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const newFolderName = uniqueSuffix + '-' + folder.name;
      const newPath = path.join(targetPath, newFolderName);

      // Copy physical folder
      await fs.copy(folder.path, newPath);

      // Create new database entry
      const newFolder = new Folder({
        name: newFolderName,
        owner: req.user._id,
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

// Browse shared folder contents (for authenticated shared-with-me users)
router.get('/shared/:folderId', validateExternalToken, async (req, res) => {
  try {
    const { folderId } = req.params;

    // Check if user has share access to this folder (or any parent)
    const folder = await Folder.findById(folderId);
    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // Check direct share on this folder or any ancestor
    let currentId = folderId;
    let hasAccess = false;

    while (currentId) {
      const share = await Share.findOne({
        itemId: currentId, itemType: 'folder', isActive: true,
        $or: [
          { 'sharedWith.email': req.user.email },
          { 'sharedWith.userId': req.user._id }
        ]
      });
      if (share) {
        hasAccess = true;
        break;
      }
      const parentFolder = await Folder.findById(currentId);
      currentId = parentFolder?.parent || null;
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const [folders, files] = await Promise.all([
      Folder.find({ parent: folderId }).select('name createdAt').sort({ name: 1 }),
      File.find({ folder: folderId }).select('originalName name mimeType size fileType createdAt _id').sort({ createdAt: -1 })
    ]);

    res.json({ folders, files });
  } catch (error) {
    console.error('Shared folder browse error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
