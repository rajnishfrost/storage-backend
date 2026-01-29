const fs = require('fs').promises;
const exifParser = require('exif-parser');
const sharp = require('sharp');
const pdfParse = require('pdf-parse');
const { parseFile } = require('music-metadata');

/**
 * Extract comprehensive metadata from uploaded files
 * @param {string} filePath - Path to the file
 * @param {string} mimeType - MIME type of the file
 * @returns {Object} Metadata object
 */
async function extractMetadata(filePath, mimeType) {
  const metadata = {
    exif: {},
    gps: {},
    fileSystem: {},
    dimensions: {},
    documentInfo: {},
    audioInfo: {}
  };

  try {
    // Get file system metadata
    const stats = await fs.stat(filePath);
    metadata.fileSystem = {
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime,
      accessedAt: stats.atime
    };

    // Extract image metadata
    if (mimeType.startsWith('image/')) {
      await extractImageMetadata(filePath, metadata);
    }

    // Extract video metadata (basic for now)
    if (mimeType.startsWith('video/')) {
      // You can add video metadata extraction here using ffmpeg
      metadata.duration = null;
    }

    // Extract PDF metadata
    if (mimeType === 'application/pdf') {
      await extractPdfMetadata(filePath, metadata);
    }

    // Extract audio metadata
    if (mimeType.startsWith('audio/')) {
      await extractAudioMetadata(filePath, metadata);
    }

  } catch (error) {
    console.error('Error extracting metadata:', error);
  }

  return metadata;
}

/**
 * Extract EXIF and image-specific metadata
 */
async function extractImageMetadata(filePath, metadata) {
  try {
    // Use sharp to get image dimensions and basic info
    const sharpMetadata = await sharp(filePath).metadata();

    metadata.dimensions = {
      width: sharpMetadata.width,
      height: sharpMetadata.height
    };

    // Try to extract EXIF data
    const buffer = await fs.readFile(filePath);

    try {
      const parser = exifParser.create(buffer);
      const result = parser.parse();

      if (result.tags) {
        const tags = result.tags;

        // Camera information
        if (tags.Make) metadata.exif.make = tags.Make;
        if (tags.Model) metadata.exif.model = tags.Model;
        if (tags.Software) metadata.exif.software = tags.Software;

        // Date/Time
        if (tags.DateTime) metadata.exif.dateTime = new Date(tags.DateTime * 1000);
        if (tags.DateTimeOriginal) metadata.exif.dateTimeOriginal = new Date(tags.DateTimeOriginal * 1000);
        if (tags.DateTimeDigitized) metadata.exif.dateTimeDigitized = new Date(tags.DateTimeDigitized * 1000);

        // Camera settings
        if (tags.ExposureTime) {
          metadata.exif.exposureTime = tags.ExposureTime < 1
            ? `1/${Math.round(1/tags.ExposureTime)}`
            : `${tags.ExposureTime}`;
        }
        if (tags.FNumber) metadata.exif.fNumber = tags.FNumber;
        if (tags.ISO) metadata.exif.iso = tags.ISO;
        if (tags.FocalLength) metadata.exif.focalLength = tags.FocalLength;
        if (tags.Flash) metadata.exif.flash = tags.Flash ? 'Yes' : 'No';
        if (tags.WhiteBalance) metadata.exif.whiteBalance = tags.WhiteBalance === 0 ? 'Auto' : 'Manual';
        if (tags.Orientation) metadata.exif.orientation = tags.Orientation;
        if (tags.ColorSpace) metadata.exif.colorSpace = tags.ColorSpace === 1 ? 'sRGB' : 'Other';

        // Image dimensions from EXIF
        if (tags.ImageWidth) metadata.exif.width = tags.ImageWidth;
        if (tags.ImageHeight) metadata.exif.height = tags.ImageHeight;
      }

      // GPS data
      if (result.tags.GPSLatitude && result.tags.GPSLongitude) {
        metadata.gps.latitude = result.tags.GPSLatitude;
        metadata.gps.longitude = result.tags.GPSLongitude;
        metadata.gps.latitudeRef = result.tags.GPSLatitudeRef || 'N';
        metadata.gps.longitudeRef = result.tags.GPSLongitudeRef || 'E';

        if (result.tags.GPSAltitude) {
          metadata.gps.altitude = result.tags.GPSAltitude;
          metadata.gps.altitudeRef = result.tags.GPSAltitudeRef || 0;
        }

        if (result.tags.GPSDateStamp && result.tags.GPSTimeStamp) {
          // Combine date and time
          const dateStr = result.tags.GPSDateStamp;
          const timeArr = result.tags.GPSTimeStamp;
          if (timeArr && timeArr.length === 3) {
            const gpsDate = new Date(
              `${dateStr} ${timeArr[0]}:${timeArr[1]}:${timeArr[2]}`
            );
            // Only set if valid date
            if (!isNaN(gpsDate.getTime())) {
              metadata.gps.timestamp = gpsDate;
            }
          }
        }
      }

    } catch (exifError) {
      // Some images may not have EXIF data, that's okay
      console.log('No EXIF data found or error parsing:', exifError.message);
    }

  } catch (error) {
    console.error('Error extracting image metadata:', error);
  }
}

/**
 * Extract PDF metadata
 */
async function extractPdfMetadata(filePath, metadata) {
  try {
    const dataBuffer = await fs.readFile(filePath);

    // pdf-parse v2.4.5 uses PDFParse class
    const { PDFParse } = pdfParse;
    const parser = new PDFParse();
    const pdfData = await parser.parse(dataBuffer);

    metadata.documentInfo = {
      pages: pdfData.numpages || pdfData.numPages || null,
      title: pdfData.info?.Title || null,
      author: pdfData.info?.Author || null,
      subject: pdfData.info?.Subject || null,
      creator: pdfData.info?.Creator || null,
      producer: pdfData.info?.Producer || null,
      creationDate: pdfData.info?.CreationDate || null,
      modificationDate: pdfData.info?.ModDate || null,
      keywords: pdfData.info?.Keywords || null
    };
  } catch (error) {
    console.error('Error extracting PDF metadata:', error.message);
  }
}

/**
 * Extract audio metadata
 */
async function extractAudioMetadata(filePath, metadata) {
  try {
    const audioMetadata = await parseFile(filePath);

    metadata.audioInfo = {
      duration: audioMetadata.format.duration || null,
      bitrate: audioMetadata.format.bitrate || null,
      sampleRate: audioMetadata.format.sampleRate || null,
      numberOfChannels: audioMetadata.format.numberOfChannels || null,
      codec: audioMetadata.format.codec || null,
      lossless: audioMetadata.format.lossless || false,
      // Tags
      title: audioMetadata.common.title || null,
      artist: audioMetadata.common.artist || null,
      album: audioMetadata.common.album || null,
      year: audioMetadata.common.year || null,
      genre: audioMetadata.common.genre ? audioMetadata.common.genre.join(', ') : null,
      albumArtist: audioMetadata.common.albumartist || null,
      track: audioMetadata.common.track?.no || null,
      disk: audioMetadata.common.disk?.no || null,
      comment: audioMetadata.common.comment ? audioMetadata.common.comment.join(', ') : null
    };
  } catch (error) {
    console.error('Error extracting audio metadata:', error.message);
  }
}

module.exports = {
  extractMetadata
};
