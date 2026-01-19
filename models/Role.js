const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  displayName: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  permissions: [{
    type: String,
    enum: [
      'read_files',
      'write_files',
      'delete_files',
      'manage_users',
      'manage_roles',
      'view_analytics',
      'system_settings'
    ]
  }],
  isSystemRole: {
    type: Boolean,
    default: false // System roles (super_admin, admin, user) cannot be deleted
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Role', roleSchema);
