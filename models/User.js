const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  role: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Role',
    required: true
  },
  storageQuota: {
    type: Number,
    default: 5, // in GB
    required: true
  },
  usedStorage: {
    type: Number,
    default: 0 // in bytes
  },
  storagePath: {
    type: String,
    default: './uploads'
  },
  storagePaths: {
    type: [String],
    default: []
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to get storage quota in bytes
userSchema.methods.getQuotaInBytes = function() {
  return this.storageQuota * 1024 * 1024 * 1024; // Convert GB to bytes
};

// Method to check if user has space
userSchema.methods.hasSpace = function(fileSize) {
  return (this.usedStorage + fileSize) <= this.getQuotaInBytes();
};

module.exports = mongoose.model('User', userSchema);
