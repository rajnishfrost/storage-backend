const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  originalName: {
    type: String,
    required: true
  },
  mimeType: {
    type: String,
    required: true
  },
  size: {
    type: Number,
    required: true // in bytes
  },
  path: {
    type: String,
    required: true
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  folder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    default: null // null means root
  },
  fileType: {
    type: String,
    enum: ['image', 'video', 'document', 'pdf', 'text', 'other'],
    required: true
  },
  metadata: {
    // Image EXIF data
    exif: {
      make: String,              // Camera manufacturer (e.g., "Canon")
      model: String,             // Camera model (e.g., "Canon EOS 5D")
      software: String,          // Software used
      dateTime: Date,            // Original date/time photo was taken
      dateTimeOriginal: Date,    // Original creation date
      dateTimeDigitized: Date,   // Digitization date
      exposureTime: String,      // Shutter speed
      fNumber: Number,           // Aperture
      iso: Number,               // ISO speed
      focalLength: Number,       // Focal length in mm
      flash: String,             // Flash fired or not
      whiteBalance: String,      // White balance mode
      orientation: Number,       // Image orientation
      width: Number,             // Image width in pixels
      height: Number,            // Image height in pixels
      colorSpace: String         // Color space
    },
    // GPS/Location data
    gps: {
      latitude: Number,
      longitude: Number,
      altitude: Number,
      latitudeRef: String,       // N or S
      longitudeRef: String,      // E or W
      altitudeRef: Number,
      timestamp: Date
    },
    // File system metadata
    fileSystem: {
      createdAt: Date,
      modifiedAt: Date,
      accessedAt: Date
    },
    // Additional info
    dimensions: {
      width: Number,
      height: Number
    },
    duration: Number,             // For videos (in seconds)
    // PDF/Document metadata
    documentInfo: {
      pages: Number,
      title: String,
      author: String,
      subject: String,
      creator: String,
      producer: String,
      creationDate: String,
      modificationDate: String,
      keywords: String
    },
    // Audio metadata
    audioInfo: {
      duration: Number,
      bitrate: Number,
      sampleRate: Number,
      numberOfChannels: Number,
      codec: String,
      lossless: Boolean,
      title: String,
      artist: String,
      album: String,
      year: Number,
      genre: String,
      albumArtist: String,
      track: Number,
      disk: Number,
      comment: String
    }
  }
}, {
  timestamps: true
});

// Index for faster queries
fileSchema.index({ owner: 1, folder: 1 });

// Static method to determine file type
fileSchema.statics.getFileType = function(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('text/') || mimeType === 'application/rtf' || mimeType === 'text/rtf') return 'text';
  if (mimeType.includes('document') || mimeType.includes('word') || mimeType.includes('sheet')) return 'document';
  return 'other';
};

module.exports = mongoose.model('File', fileSchema);
