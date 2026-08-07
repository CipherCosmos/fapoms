import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet, Image, ScrollView, Alert, ActivityIndicator, Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Icon, IconButton, Tappable } from './ui/primitives';
import { assetToBase64 } from '../utils/pickDocument';

// Safe dynamic load for native MLKit scanner plugin
let DocumentScanner: any = null;
let ResponseType: any = { Base64: 'base64' };
try {
  if (Platform.OS !== 'web') {
    const plugin = require('react-native-document-scanner-plugin');
    DocumentScanner = plugin.default || plugin;
    ResponseType = plugin.ResponseType || ResponseType;
  }
} catch {
  // Graceful web fallback
}

export interface MLKitScannerModalProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Receives EVERY captured page, not just the first, plus the real media type.
   * Previously this handed over only `scannedPages[0]` under a `.pdf` name.
   */
  onPdfGenerated: (baseName: string, pages: { base64: string; pageNumber: number }[], mimeType: string) => void;
}

export const MLKitScannerModal: React.FC<MLKitScannerModalProps> = ({
  visible,
  onClose,
  onPdfGenerated,
}) => {
  const t = useTheme();
  const [scannedPages, setScannedPages] = useState<Array<{ uri: string; base64: string; pageNumber: number; enhanced: boolean }>>([]);
  const [isLiveCameraActive, setIsLiveCameraActive] = useState(true);
  const [isProcessingPdf, setIsProcessingPdf] = useState(false);
  const [contrastFilter, setContrastFilter] = useState<'AUTO' | 'DOCUMENT_ENHANCE' | 'GRAYSCALE'>('AUTO');
  const [cameraPermissionGranted, setCameraPermissionGranted] = useState<boolean | null>(null);

  const videoRef = useRef<any>(null);
  const canvasRef = useRef<any>(null);
  const mediaStreamRef = useRef<any>(null);

  const [isAutoCaptureEnabled, setIsAutoCaptureEnabled] = useState(true);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [stabilityScore, setStabilityScore] = useState(0);
  const [detectedQuad, setDetectedQuad] = useState<{ x1: number; y1: number; x2: number; y2: number; x3: number; y3: number; x4: number; y4: number } | null>(null);
  const [isDocumentDetected, setIsDocumentDetected] = useState(false);
  const [selectedPageForCrop, setSelectedPageForCrop] = useState<number | null>(null);
  const [rotationDegrees, setRotationDegrees] = useState<number>(0);

  const autoCaptureTimerRef = useRef<any>(null);
  const animationFrameRef = useRef<any>(null);

  // Trigger Native Google MLKit Document Scanner (Android) / Apple VisionKit (iOS)
  const startNativeMlKitScan = async () => {
    try {
      if (Platform.OS !== 'web' && DocumentScanner?.scanDocument) {
        const { scannedImages } = await DocumentScanner.scanDocument({
          responseType: ResponseType.Base64,
          maxNumDocuments: 10,
        });

        if (scannedImages && scannedImages.length > 0) {
          const newPages = scannedImages.map((b64: string, idx: number) => ({
            uri: `data:image/jpeg;base64,${b64}`,
            base64: b64,
            pageNumber: scannedPages.length + idx + 1,
            enhanced: true,
          }));
          setScannedPages((prev) => [...prev, ...newPages]);
          // Leaves the live-camera view so the review list and the "Compile" footer render.
          // Without this the native path stayed in live mode forever and the footer — which
          // is gated on `!isLiveCameraActive` — never appeared.
          setIsLiveCameraActive(false);
          return;
        }
      }
    } catch (err: any) {
      console.warn('Native MLKit Scanner unavailable or cancelled:', err);
    } finally {
      /**
       * On native we must never stay in the live-camera view.
       *
       * `isLiveCameraActive` initialises to `true`, and the only places that cleared it were
       * web-only (`onClick` handlers on DOM `<button>`s). So on the shipped Android build the
       * assayer saw a black "Native Camera Stream" placeholder with no shutter, no gallery and
       * no compile button — only a close X. The primary route for capturing bank collateral
       * audit sheets was unusable on the only platform that ships.
       */
      if (Platform.OS !== 'web') {
        setIsLiveCameraActive(false);
      }
    }
  };

  // Initialize Real Video Stream when Live Camera view opens
  useEffect(() => {
    if (visible && Platform.OS !== 'web') {
      startNativeMlKitScan();
    }
  }, [visible]);

  useEffect(() => {
    if (isLiveCameraActive && Platform.OS === 'web') {
      startWebCamera();
    } else {
      stopWebCamera();
    }
    return () => {
      stopWebCamera();
    };
  }, [isLiveCameraActive, isTorchOn]);

  const startWebCamera = async () => {
    try {
      const nav: any = typeof navigator !== 'undefined' ? navigator : {};
      if (nav.mediaDevices && nav.mediaDevices.getUserMedia) {
        const stream = await nav.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        mediaStreamRef.current = stream;
        setCameraPermissionGranted(true);
        if (videoRef.current) {
          (videoRef.current as any).srcObject = stream;
          videoRef.current.play();
        }

        // Enable torch track if requested and available
        if (isTorchOn) {
          const track = stream.getVideoTracks()?.[0];
          if (track && track.applyConstraints) {
            track.applyConstraints({ advanced: [{ torch: true }] } as any).catch(() => {});
          }
        }

        startRealTimeCornerDetection();
      } else {
        setCameraPermissionGranted(false);
      }
    } catch (err: any) {
      console.error('Camera Stream Error:', err);
      setCameraPermissionGranted(false);
    }
  };

  const stopWebCamera = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    if (autoCaptureTimerRef.current) {
      clearTimeout(autoCaptureTimerRef.current);
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track: any) => track.stop());
      mediaStreamRef.current = null;
    }
  };

  // Real-Time Document Quad & Edge Detection Analysis (Sobel + Skin Tone Filter)
  const startRealTimeCornerDetection = () => {
    let steadyCounter = 0;
    const sampleWidth = 160;
    const sampleHeight = 90;

    const analyzeFrame = () => {
      if (videoRef.current && videoRef.current.readyState === 4) {
        const video = videoRef.current;

        const doc: any = typeof globalThis !== 'undefined' ? (globalThis as any).document : undefined;
        if (doc) {
          const sampleCanvas = canvasRef.current || doc.createElement('canvas');
          sampleCanvas.width = sampleWidth;
          sampleCanvas.height = sampleHeight;
          const sCtx = sampleCanvas.getContext('2d');

          if (sCtx) {
            sCtx.drawImage(video, 0, 0, sampleWidth, sampleHeight);
            const imgData = sCtx.getImageData(0, 0, sampleWidth, sampleHeight);
            const data = imgData.data;

            // 1. Skin-Tone Detection & Suppression (Prevents Face False Positives)
            let skinPixelCount = 0;
            const totalPixels = sampleWidth * sampleHeight;
            const gray = new Float32Array(totalPixels);

            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];

              // Normalized skin tone range check (RGB Rule for human face / skin)
              if (r > 95 && g > 40 && b > 20 && (Math.max(r, g, b) - Math.min(r, g, b)) > 15 && Math.abs(r - g) > 15 && r > g && r > b) {
                skinPixelCount++;
              }

              // Luminance grayscale conversion
              gray[i / 4] = 0.299 * r + 0.587 * g + 0.114 * b;
            }

            const skinRatio = skinPixelCount / totalPixels;

            // 2. Sobel Edge Gradient Magnitude (Detects Rectangular Paper Margins)
            let strongEdgeCount = 0;
            const minX = Math.floor(sampleWidth * 0.1);
            const maxX = Math.floor(sampleWidth * 0.9);
            const minY = Math.floor(sampleHeight * 0.15);
            const maxY = Math.floor(sampleHeight * 0.85);

            for (let y = minY; y < maxY; y++) {
              for (let x = minX; x < maxX; x++) {
                const idx = y * sampleWidth + x;
                // Horizontal gradient Gx
                const gx = -gray[idx - sampleWidth - 1] + gray[idx - sampleWidth + 1]
                           - 2 * gray[idx - 1] + 2 * gray[idx + 1]
                           - gray[idx + sampleWidth - 1] + gray[idx + sampleWidth + 1];
                // Vertical gradient Gy
                const gy = -gray[idx - sampleWidth - 1] - 2 * gray[idx - sampleWidth] - gray[idx - sampleWidth + 1]
                           + gray[idx + sampleWidth - 1] + 2 * gray[idx + sampleWidth] + gray[idx + sampleWidth + 1];

                const edgeMagnitude = Math.sqrt(gx * gx + gy * gy);
                if (edgeMagnitude > 140) {
                  strongEdgeCount++;
                }
              }
            }

            // Calculate bounding quad of detected document paper edges
            let minEdgeX = sampleWidth;
            let maxEdgeX = 0;
            let minEdgeY = sampleHeight;
            let maxEdgeY = 0;

            if (strongEdgeCount > 120 && skinRatio < 0.18) {
              for (let y = minY; y < maxY; y++) {
                for (let x = minX; x < maxX; x++) {
                  const idx = y * sampleWidth + x;
                  const gx = -gray[idx - sampleWidth - 1] + gray[idx - sampleWidth + 1] - 2 * gray[idx - 1] + 2 * gray[idx + 1];
                  const gy = -gray[idx - sampleWidth - 1] - 2 * gray[idx - sampleWidth] + gray[idx + sampleWidth - 1] + 2 * gray[idx + sampleWidth];
                  if (Math.sqrt(gx * gx + gy * gy) > 130) {
                    if (x < minEdgeX) minEdgeX = x;
                    if (x > maxEdgeX) maxEdgeX = x;
                    if (y < minEdgeY) minEdgeY = y;
                    if (y > maxEdgeY) maxEdgeY = y;
                  }
                }
              }
            }

            const quadWidth = maxEdgeX - minEdgeX;
            const quadHeight = maxEdgeY - minEdgeY;
            const isRectangularDocument = skinRatio < 0.18 && strongEdgeCount > 140 && quadWidth > 40 && quadHeight > 25;

            setIsDocumentDetected(isRectangularDocument);

            if (isRectangularDocument) {
              steadyCounter = Math.min(100, steadyCounter + 8);
              // Normalize quad percentages relative to frame
              setDetectedQuad({
                x1: Math.max(5, (minEdgeX / sampleWidth) * 100),
                y1: Math.max(5, (minEdgeY / sampleHeight) * 100),
                x2: Math.min(95, (maxEdgeX / sampleWidth) * 100),
                y2: Math.max(5, (minEdgeY / sampleHeight) * 100),
                x3: Math.min(95, (maxEdgeX / sampleWidth) * 100),
                y4: Math.min(95, (maxEdgeY / sampleHeight) * 100),
                x4: Math.max(5, (minEdgeX / sampleWidth) * 100),
                y3: Math.min(95, (maxEdgeY / sampleHeight) * 100),
              });
            } else {
              steadyCounter = Math.max(0, steadyCounter - 25);
              setDetectedQuad(null);
            }

            setStabilityScore(steadyCounter);

            // Auto-Capture Trigger only when auto capture is toggled ON, face is absent, and document quad is steady
            if (isAutoCaptureEnabled && isRectangularDocument && steadyCounter >= 95) {
              steadyCounter = 0;
              captureLiveCameraFrame();
              return;
            }
          }
        }
      }

      animationFrameRef.current = requestAnimationFrame(analyzeFrame);
    };

    animationFrameRef.current = requestAnimationFrame(analyzeFrame);
  };

  // Real-Time Frame Capture with Google MLKit Edge Correction Processing
  const captureLiveCameraFrame = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;

    const doc: any = typeof globalThis !== 'undefined' ? (globalThis as any).document : undefined;
    const canvas = canvasRef.current || (doc ? doc.createElement('canvas') : null);
    if (!canvas) return;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      // 1. Perspective Crop Exact Detected Document Quad Bounds (Google Drive Scanner Crop)
      let cropMarginX = Math.floor(canvas.width * 0.07);
      let cropMarginY = Math.floor(canvas.height * 0.12);
      let cropWidth = canvas.width - cropMarginX * 2;
      let cropHeight = canvas.height - cropMarginY * 2;

      if (detectedQuad) {
        cropMarginX = Math.floor((detectedQuad.x1 / 100) * canvas.width);
        cropMarginY = Math.floor((detectedQuad.y1 / 100) * canvas.height);
        cropWidth = Math.floor(((detectedQuad.x2 - detectedQuad.x1) / 100) * canvas.width);
        cropHeight = Math.floor(((detectedQuad.y3 - detectedQuad.y1) / 100) * canvas.height);

        // Sanity bounds check
        if (cropWidth <= 50 || cropHeight <= 50) {
          cropMarginX = Math.floor(canvas.width * 0.07);
          cropMarginY = Math.floor(canvas.height * 0.12);
          cropWidth = canvas.width - cropMarginX * 2;
          cropHeight = canvas.height - cropMarginY * 2;
        }
      }

      ctx.drawImage(
        video,
        cropMarginX, cropMarginY, cropWidth, cropHeight,
        0, 0, canvas.width, canvas.height,
      );

      // 2. Apply MLKit Document Enhancements (Perspective & High Contrast Matrix)
      if (contrastFilter === 'DOCUMENT_ENHANCE' || contrastFilter === 'AUTO') {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        // Apply Adaptive High Contrast Thresholding for Documents
        for (let i = 0; i < data.length; i += 4) {
          const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
          const v = avg > 120 ? Math.min(255, avg * 1.15) : Math.max(0, avg * 0.85);
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
        }
        ctx.putImageData(imageData, 0, 0);
      } else if (contrastFilter === 'GRAYSCALE') {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          data[i] = gray;
          data[i + 1] = gray;
          data[i + 2] = gray;
        }
        ctx.putImageData(imageData, 0, 0);
      }

      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const base64 = dataUrl.split(',')[1];

      setScannedPages((prev) => [
        ...prev,
        {
          uri: dataUrl,
          base64,
          pageNumber: prev.length + 1,
          enhanced: true,
        },
      ]);
      setIsLiveCameraActive(false);
    }
  };

  const handlePickFileFallback = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        const base64 = await assetToBase64(asset);

        setScannedPages((prev) => [
          ...prev,
          {
            uri: asset.uri,
            base64,
            pageNumber: prev.length + 1,
            enhanced: true,
          },
        ]);
      }
    } catch (err: any) {
      Alert.alert('File Picker Error', err?.message || 'Failed to select document.');
    }
  };

  const handleRemovePage = (index: number) => {
    setScannedPages((prev) => {
      const updated = prev.filter((_, i) => i !== index);
      return updated.map((p, idx) => ({ ...p, pageNumber: idx + 1 }));
    });
  };

  const handleGeneratePdfFromRealPages = async () => {
    if (scannedPages.length === 0) {
      Alert.alert('No Pages Scanned', 'Please capture at least 1 real document page before generating PDF.');
      return;
    }

    try {
      setIsProcessingPdf(true);
      const timestamp = Date.now();
      const baseName = `Audit_Scan_${timestamp}`;

      /**
       * Every page is handed over, in order.
       *
       * This used to take `scannedPages[0].base64` and drop pages 2..N on the floor with no
       * warning — an assayer scanning a six-page collateral packet uploaded one page and was
       * told the scan completed. For evidence in a bank audit, silently keeping 1/6 of the
       * paperwork is worse than failing outright.
       *
       * The captures are JPEGs from ML Kit. There is no PDF assembler on the device, so they
       * are declared as what they are (`image/jpeg`) rather than relabelled `.pdf` — the old
       * behaviour wrote JPEG bytes into rows recorded as `application/pdf`, which is why the
       * live document table contains files that no PDF reader can open.
       */
      const pages = scannedPages.map((pg, i) => ({ base64: pg.base64, pageNumber: i + 1 }));

      setIsProcessingPdf(false);
      onPdfGenerated(baseName, pages, 'image/jpeg');
      setScannedPages([]);
      onClose();
    } catch (err: any) {
      setIsProcessingPdf(false);
      Alert.alert('PDF Compiler Error', err?.message || 'Failed to assemble real PDF from scanned pages.');
    }
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={styles.container}>
        {/* Header */}
        <View style={{
          paddingTop: Platform.OS === 'ios' ? 50 : 20,
          paddingHorizontal: t.space.lg,
          paddingBottom: t.space.sm,
          backgroundColor: t.colors.surface,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottomWidth: 1,
          borderColor: t.colors.border,
        }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="camera-outline" size={20} color={t.colors.primary} />
              <AppText variant="h3">Document Scanner</AppText>
            </View>
            <AppText variant="caption" tone="muted" style={{ marginTop: 2 }}>Auto boundary detection & perspective enhancement</AppText>
          </View>
          <IconButton icon="close" onPress={onClose} />
        </View>

        {/* Filter Controls */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: t.space.xs,
          paddingHorizontal: t.space.lg,
          paddingVertical: t.space.sm,
          backgroundColor: t.colors.surface,
          borderBottomWidth: 1,
          borderColor: t.colors.border,
        }}>
          {(['AUTO', 'DOCUMENT_ENHANCE', 'GRAYSCALE'] as const).map((mode) => {
            const active = contrastFilter === mode;
            return (
              <Tappable key={mode} onPress={() => setContrastFilter(mode)}>
                <View style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: t.radius.pill,
                  backgroundColor: active ? t.colors.primarySoft : t.colors.bg,
                  borderWidth: 1,
                  borderColor: active ? t.colors.primary : t.colors.border,
                }}>
                  <AppText variant="caption" tone={active ? 'primary' : 'faint'} style={{ fontWeight: active ? '700' : '500' }}>
                    {mode === 'AUTO' ? 'Auto Enhance' : mode === 'DOCUMENT_ENHANCE' ? 'High Contrast' : 'B&W Sharp'}
                  </AppText>
                </View>
              </Tappable>
            );
          })}
        </View>

        {/* LIVE CAMERA VIEWFINDER MODAL OVERLAY */}
        {isLiveCameraActive ? (
          <View style={styles.cameraViewfinderContainer}>
            {Platform.OS === 'web' ? (
              <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', overflow: 'hidden' }}>
                <video
                  ref={(ref) => {
                    videoRef.current = ref;
                    if (ref && mediaStreamRef.current) (ref as any).srcObject = mediaStreamRef.current;
                  }}
                  autoPlay
                  playsInline
                  muted
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
                <canvas ref={canvasRef} style={{ display: 'none' }} />

                {/* Google Drive Style HUD Header Controls */}
                <div style={{ position: 'absolute', top: '20px', left: '20px', right: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 20 }}>
                  <button
                    onClick={() => setIsLiveCameraActive(false)}
                    style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', padding: '8px 16px', borderRadius: '20px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
                  >
                    ← Close Scanner
                  </button>

                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button
                      onClick={() => setIsAutoCaptureEnabled((v) => !v)}
                      style={{
                        background: isAutoCaptureEnabled ? 'rgba(59, 130, 246, 0.9)' : 'rgba(0,0,0,0.6)',
                        border: '1px solid rgba(255,255,255,0.2)', color: '#fff', padding: '8px 14px', borderRadius: '20px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px',
                      }}
                    >
                      {isAutoCaptureEnabled ? '⚡ AUTO CAPTURE ON' : '✋ MANUAL CAPTURE'}
                    </button>
                    <button
                      onClick={() => setIsTorchOn((v) => !v)}
                      style={{
                        background: isTorchOn ? 'rgba(234, 179, 8, 0.9)' : 'rgba(0,0,0,0.6)',
                        border: '1px solid rgba(255,255,255,0.2)', color: '#fff', padding: '8px 14px', borderRadius: '20px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                      }}
                    >
                      {isTorchOn ? '💡 FLASH ON' : '💡 FLASH OFF'}
                    </button>
                  </div>
                </div>

                {/* Google Drive Blue Quad Boundary Overlay with Interactive Target Handles */}
                {detectedQuad && (
                  <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 15 }}>
                    <polygon
                      points={`${detectedQuad.x1}%,${detectedQuad.y1}% ${detectedQuad.x2}%,${detectedQuad.y2}% ${detectedQuad.x3}%,${detectedQuad.y3}% ${detectedQuad.x4}%,${detectedQuad.y4}%`}
                      fill="rgba(59, 130, 246, 0.3)"
                      stroke="#3b82f6"
                      strokeWidth="3.5"
                    />
                    {/* Interactive Drag Handles (Corners) */}
                    <g style={{ cursor: 'pointer', pointerEvents: 'auto' }}>
                      <circle cx={`${detectedQuad.x1}%`} cy={`${detectedQuad.y1}%`} r="10" fill="#3b82f6" stroke="#ffffff" strokeWidth="2.5" />
                      <circle cx={`${detectedQuad.x2}%`} cy={`${detectedQuad.y2}%`} r="10" fill="#3b82f6" stroke="#ffffff" strokeWidth="2.5" />
                      <circle cx={`${detectedQuad.x3}%`} cy={`${detectedQuad.y3}%`} r="10" fill="#3b82f6" stroke="#ffffff" strokeWidth="2.5" />
                      <circle cx={`${detectedQuad.x4}%`} cy={`${detectedQuad.y4}%`} r="10" fill="#3b82f6" stroke="#ffffff" strokeWidth="2.5" />
                    </g>
                  </svg>
                )}

                {/* Google Drive Status Bar Header */}
                <div style={{
                  position: 'absolute', top: '75px', left: 0, right: 0,
                  display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 18,
                }}>
                  <div style={{
                    background: isDocumentDetected ? (stabilityScore > 80 ? '#22c55e' : 'rgba(34, 197, 94, 0.92)') : 'rgba(15, 23, 42, 0.88)',
                    color: '#fff', fontSize: '13px', fontWeight: 700, padding: '7px 20px', borderRadius: '24px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)', backdropFilter: 'blur(6px)',
                    display: 'flex', alignItems: 'center', gap: '8px',
                  }}>
                    <span>
                      {isDocumentDetected
                        ? (stabilityScore >= 95 ? '📸 Capturing Document…' : '✓ Document Detected · Hold Still')
                        : '📐 Point camera directly at document'}
                    </span>
                  </div>
                </div>

                {/* Viewfinder Bottom Controls Bar */}
                <div style={{ position: 'absolute', bottom: '28px', left: 0, right: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '32px', zIndex: 20 }}>
                  {/* Scanned Pages Counter Badge */}
                  {scannedPages.length > 0 && (
                    <button
                      onClick={() => setIsLiveCameraActive(false)}
                      style={{
                        position: 'relative', width: '50px', height: '50px', borderRadius: '12px',
                        background: '#1e293b', border: '2px solid #38bdf8', overflow: 'hidden',
                        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      <img src={scannedPages[scannedPages.length - 1].uri} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <span style={{ position: 'absolute', top: '-4px', right: '-4px', background: '#0284c7', color: '#fff', fontSize: '11px', fontWeight: 800, width: '20px', height: '20px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {scannedPages.length}
                      </span>
                    </button>
                  )}

                  {/* Main Shutter Button */}
                  <button
                    onClick={captureLiveCameraFrame}
                    style={{
                      width: '76px', height: '76px', borderRadius: '50%',
                      background: '#ffffff', border: '4px solid #38bdf8',
                      cursor: 'pointer', boxShadow: '0 4px 24px rgba(56,189,248,0.5)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'transform 0.1s ease',
                    }}
                  >
                    <div style={{ width: '60px', height: '60px', borderRadius: '50%', background: '#0284c7' }} />
                  </button>
                </div>
              </div>
            ) : (
              <View style={styles.emptyContainer}>
                <AppText variant="h3">Native Camera Stream</AppText>
              </View>
            )}
          </View>
        ) : (
          /* SCANNED PAGES GALLERY */
          <ScrollView contentContainerStyle={styles.galleryContent}>
            {scannedPages.length === 0 ? (
              <View style={styles.emptyContainer}>
                <AppText style={{ fontSize: 52, marginBottom: 12 }}>📷</AppText>
                <AppText variant="h2">Live Document Viewfinder Ready</AppText>
                <AppText variant="body" tone="muted" style={{ textAlign: 'center', marginTop: 8 }}>
                  Tap "Open Live Camera Viewfinder" to start the real-time camera stream. Align audit document pages within the MLKit bounding box to scan & generate PDF.
                </AppText>
              </View>
            ) : (
              <View style={styles.grid}>
                {scannedPages.map((page, idx) => (
                  <View key={idx} style={styles.pageCard}>
                    <Image source={{ uri: page.uri }} style={styles.pageImage} resizeMode="cover" />
                    <View style={styles.pageBadge}>
                      <AppText variant="caption" tone="primary">Page {page.pageNumber}</AppText>
                    </View>
                    <Button
                      label="Remove"
                      variant="danger"
                      size="sm"
                      icon="trash"
                      onPress={() => handleRemovePage(idx)}
                    />
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        )}

        {/* Footer Actions */}
        {!isLiveCameraActive && (
          <View style={{ padding: t.space.lg, gap: t.space.md, backgroundColor: t.colors.surface, borderTopWidth: 1, borderColor: t.colors.border }}>
            <View style={{ flexDirection: 'row', gap: t.space.md }}>
              <Button
                label={`Open Camera (${scannedPages.length})`}
                icon="camera"
                onPress={() => setIsLiveCameraActive(true)}
                disabled={isProcessingPdf}
                style={{ flex: 2 }}
              />
              <Button
                label="Pick File"
                icon="document-attach"
                variant="neutral"
                onPress={handlePickFileFallback}
                style={{ flex: 1 }}
              />
            </View>

            <Button
              label={`Compile Scanned PDF (${scannedPages.length} Pages)`}
              icon="document-text"
              variant="accent"
              onPress={handleGeneratePdfFromRealPages}
              loading={isProcessingPdf}
              disabled={scannedPages.length === 0 || isProcessingPdf}
              full
            />
          </View>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#38bdf8',
  },
  subtitle: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  closeBtnText: {
    color: '#fca5a5',
    fontSize: 12,
    fontWeight: '700',
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#182238',
    gap: 8,
  },
  filterLabel: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '600',
  },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#334155',
  },
  filterChipActive: {
    backgroundColor: '#FF6B00',
  },
  filterChipText: {
    fontSize: 10,
    color: '#fff',
    fontWeight: '600',
  },
  cameraViewfinderContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  galleryContent: {
    padding: 16,
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 6,
  },
  emptySub: {
    fontSize: 12,
    color: '#94a3b8',
    textAlign: 'center',
    lineHeight: 18,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  pageCard: {
    width: '48%',
    height: 220,
    backgroundColor: '#1e293b',
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#334155',
    position: 'relative',
  },
  pageImage: {
    width: '100%',
    height: '100%',
  },
  pageBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  pageBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  mlkitOverlay: {
    position: 'absolute',
    bottom: 36,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(16, 185, 129, 0.85)',
    paddingVertical: 4,
    alignItems: 'center',
  },
  mlkitOverlayText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
  },
  deleteBtn: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(239, 68, 68, 0.9)',
    paddingVertical: 6,
    alignItems: 'center',
  },
  deleteBtnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  footer: {
    padding: 16,
    backgroundColor: '#1e293b',
    borderTopWidth: 1,
    borderTopColor: '#334155',
    gap: 10,
  },
  actionBtn: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureBtn: {
    backgroundColor: '#FF6B00',
  },
  generateBtn: {
    backgroundColor: '#10b981',
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
});
