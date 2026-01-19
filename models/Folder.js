const mongoose = require('mongoose');

const folderSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  parent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    default: null // null means root folder
  },
  path: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

// Index for faster queries
folderSchema.index({ owner: 1, parent: 1 });

module.exports = mongoose.model('Folder', folderSchema);
