const mongoose = require('mongoose');

const userDetailsSchema = new mongoose.Schema({
  // Link to external auth API user - This is the ONLY connection to external system
  externalUserId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Cached user data from external API (for display purposes)
  name: {
    type: String,
    default: ''
  },

  email: {
    type: String,
    default: ''
  },

  // Storage-specific fields ONLY (not duplicating external API data)
  role: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Role',
    required: true,
    index: true
  },

  // Cached role name for quick access (avoid populate on every request)
  roleName: {
    type: String,
    enum: ['user', 'admin', 'super_admin'],
    default: 'user'
  },

  storageQuota: {
    type: Number,
    required: true,
    default: 5 // GB
  },

  usedStorage: {
    type: Number,
    default: 0 // bytes
  },

  storagePath: {
    type: String,
    default: './uploads'
  },

  storagePaths: [{
    type: String
  }],

  isActive: {
    type: Boolean,
    default: true,
    index: true
  },

  createdBy: {
    type: String, // External user ID who created this user
    default: null
  }
}, {
  timestamps: true,
  collection: 'user_details' // Explicitly set collection name
});

// Virtual for checking if quota exceeded
userDetailsSchema.virtual('isQuotaExceeded').get(function() {
  return this.usedStorage >= (this.storageQuota * 1024 * 1024 * 1024);
});

// Method to update storage usage
userDetailsSchema.methods.updateStorage = async function(sizeInBytes) {
  this.usedStorage += sizeInBytes;
  return this.save();
};

// Method to check available storage
userDetailsSchema.methods.getAvailableStorage = function() {
  const quotaInBytes = this.storageQuota * 1024 * 1024 * 1024;
  return quotaInBytes - this.usedStorage;
};

// Method to check if user has enough space for a given size
userDetailsSchema.methods.hasSpace = function(sizeInBytes) {
  const availableStorage = this.getAvailableStorage();
  return availableStorage >= sizeInBytes;
};

module.exports = mongoose.model('UserDetails', userDetailsSchema);
