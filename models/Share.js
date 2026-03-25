const mongoose = require('mongoose');

const shareSchema = new mongoose.Schema({
  itemId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  itemType: {
    type: String,
    enum: ['file', 'folder', 'system-file', 'system-folder'],
    required: true
  },
  // For system storage shares (filesystem path based, no DB entry)
  itemPath: {
    type: String,
    default: null
  },
  itemName: {
    type: String,
    default: ''
  },

  // Who shared
  sharedBy: {
    type: String,
    required: true,
    index: true
  },
  sharedByName: {
    type: String,
    default: ''
  },
  sharedByEmail: {
    type: String,
    default: ''
  },

  shareType: {
    type: String,
    enum: ['private', 'public'],
    required: true
  },

  // For private shares
  sharedWith: [{
    email: { type: String, required: true },
    userId: { type: String, default: null },
    accessType: { type: String, enum: ['view', 'download'], default: 'view' }
  }],

  // For public shares
  publicToken: {
    type: String,
    unique: true,
    sparse: true
  },

  isActive: {
    type: Boolean,
    default: true
  },

  expiresAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Indexes
shareSchema.index({ sharedBy: 1, itemType: 1 });
shareSchema.index({ 'sharedWith.email': 1 });
shareSchema.index({ 'sharedWith.userId': 1 });
shareSchema.index({ publicToken: 1 });
shareSchema.index({ itemId: 1, itemType: 1 });

module.exports = mongoose.model('Share', shareSchema);
