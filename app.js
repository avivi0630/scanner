/**
 * Document Scanner App
 * All processing happens in the browser using OpenCV.js
 * No images are uploaded to any server.
 */

(function () {
    'use strict';

    // ===== State =====
    const state = {
        cvReady: false,
        currentImage: null,       // HTMLImageElement / Image object
        currentImageCanvas: null, // offscreen canvas of the source image
        corners: [],              // [{x,y}, ...] 4 points in image coords
        rotation: 0,              // 0, 90, 180, 270
        draggedCorner: -1,
        scale: 1,                 // display scale factor
        offsetX: 0,
        offsetY: 0,
        filter: 'grayscale',
        brightness: 0,
        contrast: 0,
        warpedCanvas: null,       // result after perspective transform
        filteredCanvas: null,     // result after filter
        pages: [],                // array of { id, dataUrl, name, width, height }
        cameraStream: null,
        cameraFacing: 'environment',
    };

    // ===== DOM refs =====
    const $ = id => document.getElementById(id);

    // ===== Utils =====
    function showToast(msg, type = '') {
        const container = $('toastContainer');
        const toast = document.createElement('div');
        toast.className = 'toast ' + type;
        const icon = type === 'success'
            ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
            : type === 'error'
            ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
            : '';
        toast.innerHTML = icon + '<span>' + msg + '</span>';
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    function showLoading(text) {
        $('loadingText').textContent = text || 'טוען...';
        $('loadingOverlay').classList.add('show');
    }

    function hideLoading() {
        $('loadingOverlay').classList.remove('show');
    }

    function waitOpenCV() {
        return new Promise((resolve) => {
            if (typeof cv !== 'undefined' && cv.Mat) {
                state.cvReady = true;
                resolve();
                return;
            }
            const check = setInterval(() => {
                if (typeof cv !== 'undefined' && cv.Mat) {
                    clearInterval(check);
                    state.cvReady = true;
                    resolve();
                }
            }, 100);
        });
    }

    // ===== Step Navigation =====
    function showStep(step) {
        $('uploadStep').classList.add('hidden');
        $('editStep').classList.add('hidden');
        $('filterStep').classList.add('hidden');
        if (step === 'upload') $('uploadStep').classList.remove('hidden');
        if (step === 'edit') $('editStep').classList.remove('hidden');
        if (step === 'filter') $('filterStep').classList.remove('hidden');
    }

    // ===== File Upload =====
    function handleFileSelect(e) {
        const files = e.target.files;
        if (files && files.length > 0) {
            loadImageFile(files[0]);
        }
    }

    function loadImageFile(file) {
        if (!file.type.startsWith('image/')) {
            showToast('נא לבחור קובץ תמונה', 'error');
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                state.currentImage = img;
                state.rotation = 0;
                state.filter = 'grayscale';
                state.brightness = 0;
                state.contrast = 0;
                enterEditMode();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    function enterEditMode() {
        showStep('edit');
        prepareEditCanvas();
        drawEditCanvas();
        // Run auto-detect in the background without blocking UI
        autoDetectCorners();
    }

    // ===== Edit Canvas (corner selection) =====
    function prepareEditCanvas() {
        const img = state.currentImage;
        if (!img) return;

        // Create offscreen canvas with rotation applied
        const tmp = document.createElement('canvas');
        const ctx = tmp.getContext('2d');
        const r = state.rotation;
        if (r === 90 || r === 270) {
            tmp.width = img.height;
            tmp.height = img.width;
        } else {
            tmp.width = img.width;
            tmp.height = img.height;
        }
        ctx.translate(tmp.width / 2, tmp.height / 2);
        ctx.rotate(r * Math.PI / 180);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        state.currentImageCanvas = tmp;

        // Reset corners to full image
        state.corners = [
            { x: 0, y: 0 },
            { x: tmp.width, y: 0 },
            { x: tmp.width, y: tmp.height },
            { x: 0, y: tmp.height },
        ];
    }

    function drawEditCanvas() {
        const canvas = $('editCanvas');
        const area = $('canvasArea');
        const src = state.currentImageCanvas;
        if (!src) return;

        const areaW = area.clientWidth - 16;
        const maxH = 450;
        const scale = Math.min(areaW / src.width, maxH / src.height, 1);
        state.scale = scale;

        canvas.width = src.width * scale;
        canvas.height = src.height * scale;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(src, 0, 0, canvas.width, canvas.height);

        // Draw semi-transparent mask outside corners
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(canvas.width, 0);
        ctx.lineTo(canvas.width, canvas.height);
        ctx.lineTo(0, canvas.height);
        ctx.closePath();
        // Cut out the quad
        const c = state.corners;
        ctx.moveTo(c[0].x * scale, c[0].y * scale);
        for (let i = 1; i < 4; i++) {
            ctx.lineTo(c[i].x * scale, c[i].y * scale);
        }
        ctx.closePath();
        ctx.fill('evenodd');

        // Draw the quad outline
        ctx.strokeStyle = '#06c987';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(c[0].x * scale, c[0].y * scale);
        for (let i = 1; i < 4; i++) {
            ctx.lineTo(c[i].x * scale, c[i].y * scale);
        }
        ctx.closePath();
        ctx.stroke();

        // Draw corner handles
        const handleColors = ['#3366ff', '#06c987', '#f59e0b', '#ef4444'];
        for (let i = 0; i < 4; i++) {
            const x = c[i].x * scale;
            const y = c[i].y * scale;
            // Outer ring
            ctx.beginPath();
            ctx.arc(x, y, 14, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.fill();
            // Inner dot
            ctx.beginPath();
            ctx.arc(x, y, 8, 0, Math.PI * 2);
            ctx.fillStyle = handleColors[i];
            ctx.fill();
        }
    }

    // ===== Corner interaction =====
    function getCanvasPos(e) {
        const canvas = $('editCanvas');
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        // Convert from screen pixels to canvas internal pixels,
        // then from canvas internal pixels to image coordinates.
        const ratioX = canvas.width / rect.width;
        const ratioY = canvas.height / rect.height;
        const canvasX = (clientX - rect.left) * ratioX;
        const canvasY = (clientY - rect.top) * ratioY;
        return {
            x: canvasX / state.scale,
            y: canvasY / state.scale,
            screenX: clientX,
            screenY: clientY,
        };
    }

    function findNearestCorner(pos) {
        let minDist = Infinity;
        let idx = -1;
        for (let i = 0; i < 4; i++) {
            const dx = state.corners[i].x - pos.x;
            const dy = state.corners[i].y - pos.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < minDist) {
                minDist = d;
                idx = i;
            }
        }
        // Threshold: 40px in display space
        if (minDist / state.scale < 40) return idx;
        return -1;
    }

    function onCanvasDown(e) {
        e.preventDefault();
        const pos = getCanvasPos(e);
        const idx = findNearestCorner(pos);
        if (idx >= 0) {
            state.draggedCorner = idx;
            showLoupe(pos);
        }
    }

    function onCanvasMove(e) {
        if (state.draggedCorner < 0) return;
        e.preventDefault();
        const pos = getCanvasPos(e);
        const src = state.currentImageCanvas;
        state.corners[state.draggedCorner].x = Math.max(0, Math.min(src.width, pos.x));
        state.corners[state.draggedCorner].y = Math.max(0, Math.min(src.height, pos.y));
        drawEditCanvas();
        showLoupe(pos);
    }

    function onCanvasUp() {
        state.draggedCorner = -1;
        hideLoupe();
    }

    // ===== Magnifier Loupe =====
    function showLoupe(pos) {
        const loupe = $('loupe');
        if (!loupe) return;
        const src = state.currentImageCanvas;
        if (!src) return;

        const corner = state.corners[state.draggedCorner];
        if (!corner) return;

        const loupeSize = 140;
        const zoom = 2.5;

        const canvas = $('loupeCanvas');
        canvas.width = loupeSize;
        canvas.height = loupeSize;
        const ctx = canvas.getContext('2d');

        // Source region in image coordinates
        const srcW = loupeSize / zoom;
        const srcH = loupeSize / zoom;
        const sx = corner.x - srcW / 2;
        const sy = corner.y - srcH / 2;

        // Fill white background
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, loupeSize, loupeSize);

        // Draw zoomed image region
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(src, sx, sy, srcW, srcH, 0, 0, loupeSize, loupeSize);

        // Draw crosshair at center
        ctx.strokeStyle = 'rgba(51, 102, 255, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(loupeSize / 2 - 12, loupeSize / 2);
        ctx.lineTo(loupeSize / 2 + 12, loupeSize / 2);
        ctx.moveTo(loupeSize / 2, loupeSize / 2 - 12);
        ctx.lineTo(loupeSize / 2, loupeSize / 2 + 12);
        ctx.stroke();

        // Draw center circle
        ctx.beginPath();
        ctx.arc(loupeSize / 2, loupeSize / 2, 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(6, 201, 135, 0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Position loupe near cursor but not overlapping it
        // In RTL mode, place to the left of cursor
        let loupeX = pos.screenX - loupeSize - 20;
        let loupeY = pos.screenY - loupeSize - 20;

        // Keep on screen
        if (loupeX < 8) loupeX = pos.screenX + 20;
        if (loupeY < 8) loupeY = pos.screenY + 20;
        if (loupeX + loupeSize > window.innerWidth - 8) loupeX = window.innerWidth - loupeSize - 8;
        if (loupeY + loupeSize > window.innerHeight - 8) loupeY = window.innerHeight - loupeSize - 8;

        loupe.style.left = loupeX + 'px';
        loupe.style.top = loupeY + 'px';
        loupe.classList.add('show');
    }

    function hideLoupe() {
        const loupe = $('loupe');
        if (loupe) loupe.classList.remove('show');
    }

    // ===== Auto Detect Corners (OpenCV) =====
    async function autoDetectCorners() {
        if (!state.currentImageCanvas) return;

        // Downscale for detection to avoid hanging on large images
        const fullCanvas = state.currentImageCanvas;
        const maxDim = 500;
        const detectScale = Math.min(1, maxDim / Math.max(fullCanvas.width, fullCanvas.height));

        const small = document.createElement('canvas');
        small.width = Math.round(fullCanvas.width * detectScale);
        small.height = Math.round(fullCanvas.height * detectScale);
        small.getContext('2d').drawImage(fullCanvas, 0, 0, small.width, small.height);

        try {
            await waitOpenCV();
            const src = cv.imread(small);
            const gray = new cv.Mat();
            cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
            const blur = new cv.Mat();
            cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
            const edges = new cv.Mat();
            cv.Canny(blur, edges, 30, 100);

            const kernel = cv.Mat.ones(5, 5, cv.CV_8U);
            cv.dilate(edges, edges, kernel);

            const contours = new cv.MatVector();
            const hierarchy = new cv.Mat();
            cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

            let bestQuad = null;
            let bestArea = 0;
            const imgArea = src.cols * src.rows;

            for (let i = 0; i < contours.size(); i++) {
                const cnt = contours.get(i);
                const area = cv.contourArea(cnt);
                if (area < imgArea * 0.15 || area > imgArea * 0.98) {
                    cnt.delete();
                    continue;
                }
                const approx = new cv.Mat();
                cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
                if (approx.rows === 4 && area > bestArea) {
                    bestArea = area;
                    bestQuad = [];
                    for (let j = 0; j < 4; j++) {
                        // Scale back to full image coordinates
                        bestQuad.push({
                            x: approx.data32S[j * 2] / detectScale,
                            y: approx.data32S[j * 2 + 1] / detectScale,
                        });
                    }
                }
                approx.delete();
                cnt.delete();
            }

            if (bestQuad) {
                bestQuad = sortCorners(bestQuad);
                state.corners = bestQuad;
                drawEditCanvas();
                showToast('פינות זוהו אוטומטית', 'success');
            } else {
                showToast('לא זוהו פינות אוטומטית — סמנו ידנית');
            }

            src.delete(); gray.delete(); blur.delete(); edges.delete();
            contours.delete(); hierarchy.delete(); kernel.delete();
        } catch (err) {
            console.error('Auto detect error:', err);
            showToast('זיהוי אוטומטי נכשל — סמנו ידנית', 'error');
        }
    }

    function sortCorners(pts) {
        // Sort by Y first, then X
        const sorted = pts.slice().sort((a, b) => a.y - b.y);
        const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
        const bottom = sorted.slice(2).sort((a, b) => a.x - b.x);
        // TL, TR, BR, BL
        return [top[0], top[1], bottom[1], bottom[0]];
    }

    // ===== Perspective Transform =====
    async function applyPerspectiveTransform() {
        showLoading('מיישר את הדף...');
        try {
            await waitOpenCV();
            const src = cv.imread(state.currentImageCanvas);
            const c = sortCorners(state.corners);

            // Determine output size
            const wTop = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y);
            const wBottom = Math.hypot(c[2].x - c[3].x, c[2].y - c[3].y);
            const hLeft = Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y);
            const hRight = Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y);
            const maxW = Math.round(Math.max(wTop, wBottom));
            const maxH = Math.round(Math.max(hLeft, hRight));

            const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
                c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y,
            ]);
            const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
                0, 0, maxW, 0, maxW, maxH, 0, maxH,
            ]);
            const M = cv.getPerspectiveTransform(srcPts, dstPts);
            const dst = new cv.Mat();
            cv.warpPerspective(src, dst, M, new cv.Size(maxW, maxH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

            // Convert to canvas
            const outCanvas = document.createElement('canvas');
            outCanvas.width = maxW;
            outCanvas.height = maxH;
            cv.imshow(outCanvas, dst);

            state.warpedCanvas = outCanvas;

            src.delete(); srcPts.delete(); dstPts.delete(); M.delete(); dst.delete();
        } catch (err) {
            console.error('Perspective transform error:', err);
            showToast('שגיאה ביישור הדף', 'error');
        } finally {
            hideLoading();
        }
    }

    // ===== Filters =====
    function applyFilter() {
        if (!state.warpedCanvas) return;
        const src = state.warpedCanvas;
        const canvas = $('filterCanvas');
        canvas.width = src.width;
        canvas.height = src.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(src, 0, 0);

        const filter = state.filter;
        const b = state.brightness;
        const c = state.contrast;

        // Apply brightness/contrast via filter
        ctx.filter = '';
        ctx.imageSmoothingEnabled = true;

        if (filter === 'color') {
            // Just brightness/contrast
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.filter = `brightness(${100 + b}%) contrast(${100 + c}%)`;
            ctx.drawImage(src, 0, 0);
            ctx.filter = 'none';
        } else if (filter === 'grayscale') {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.filter = `grayscale(100%) brightness(${100 + b}%) contrast(${100 + c}%)`;
            ctx.drawImage(src, 0, 0);
            ctx.filter = 'none';
        } else if (filter === 'bw' || filter === 'magic' || filter === 'enhanced') {
            applyOpenCVFilter(filter, b, c, canvas);
            return;
        }

        state.filteredCanvas = canvas;
    }

    function applyOpenCVFilter(filter, brightness, contrast, outCanvas) {
        if (!state.cvReady) {
            // Fallback to simple approach
            applyCanvasBWSimple(outCanvas);
            state.filteredCanvas = outCanvas;
            return;
        }
        try {
            const src = cv.imread(state.warpedCanvas);
            const dst = new cv.Mat();

            if (filter === 'bw') {
                // Black & white - adaptive threshold
                const gray = new cv.Mat();
                cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
                cv.adaptiveThreshold(gray, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 15, 10);
                cv.cvtColor(dst, dst, cv.COLOR_GRAY2RGBA);
                gray.delete();
            } else if (filter === 'enhanced') {
                // Enhanced color - increase saturation and contrast
                cv.cvtColor(src, dst, cv.COLOR_RGBA2RGB);
                // CLAHE on L channel
                const lab = new cv.Mat();
                cv.cvtColor(dst, lab, cv.COLOR_RGB2Lab);
                const channels = new cv.MatVector();
                cv.split(lab, channels);
                const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
                const lChannel = channels.get(0);
                const lEnhanced = new cv.Mat();
                clahe.apply(lChannel, lEnhanced);
                lEnhanced.copyTo(lChannel);
                cv.merge(channels, lab);
                cv.cvtColor(lab, dst, cv.COLOR_Lab2RGBA);
                lab.delete(); channels.delete(); lEnhanced.delete(); clahe.delete();
            } else if (filter === 'magic') {
                // Magic color - white balance + enhance
                cv.cvtColor(src, dst, cv.COLOR_RGBA2RGB);
                // Simple white balance: scale each channel so max is 255
                const channels = new cv.MatVector();
                cv.split(dst, channels);
                for (let i = 0; i < 3; i++) {
                    const ch = channels.get(i);
                    const mean = new cv.Mat();
                    const stddev = new cv.Mat();
                    cv.meanStdDev(ch, mean, stddev);
                    const m = mean.data64F[0];
                    const s = stddev.data64F[0];
                    // Stretch histogram
                    const alpha = 128 / (s || 1);
                    const beta = 128 - m * alpha;
                    ch.convertTo(ch, ch.type(), alpha, beta);
                    mean.delete(); stddev.delete();
                }
                cv.merge(channels, dst);
                cv.cvtColor(dst, dst, cv.COLOR_RGB2RGBA);
                channels.delete();

                // Then apply adaptive threshold-like for clean look
                const gray = new cv.Mat();
                cv.cvtColor(dst, gray, cv.COLOR_RGBA2GRAY);
                const result = new cv.Mat();
                cv.adaptiveThreshold(gray, result, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 15);
                cv.cvtColor(result, dst, cv.COLOR_GRAY2RGBA);
                gray.delete(); result.delete();
            }

            // Apply brightness/contrast
            if (brightness !== 0 || contrast !== 0) {
                const alpha = 1 + contrast / 100;
                const beta = brightness * 2.55;
                const adjusted = new cv.Mat();
                dst.convertTo(adjusted, dst.type(), alpha, beta);
                dst.delete();
                cv.imshow(outCanvas, adjusted);
                adjusted.delete();
            } else {
                cv.imshow(outCanvas, dst);
            }

            src.delete(); dst.delete();
            state.filteredCanvas = outCanvas;
        } catch (err) {
            console.error('Filter error:', err);
            applyCanvasBWSimple(outCanvas);
            state.filteredCanvas = outCanvas;
        }
    }

    function applyCanvasBWSimple(canvas) {
        const ctx = canvas.getContext('2d');
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            d[i] = d[i + 1] = d[i + 2] = gray > 128 ? 255 : 0;
        }
        ctx.putImageData(imgData, 0, 0);
    }

    // ===== Pages management =====
    function saveCurrentPage() {
        if (!state.filteredCanvas) {
            showToast('אין תוצאה לשמירה', 'error');
            return;
        }
        const dataUrl = state.filteredCanvas.toDataURL('image/png');
        const page = {
            id: Date.now() + Math.random(),
            dataUrl,
            name: 'דף ' + (state.pages.length + 1),
            width: state.filteredCanvas.width,
            height: state.filteredCanvas.height,
        };
        state.pages.push(page);
        renderPagesList();
        showToast('הדף נשמר בהצלחה', 'success');
        showStep('upload');
        $('fileInput').value = '';
    }

    function renderPagesList() {
        const list = $('pagesList');
        const count = state.pages.length;
        $('pageCount').textContent = count + (count === 1 ? ' דף' : ' דפים');

        const exportBtn = $('btnExportPDF');
        const pngBtn = $('btnExportPNG');
        const clearBtn = $('btnClearAll');
        exportBtn.disabled = count === 0;
        pngBtn.disabled = count === 0;
        clearBtn.disabled = count === 0;

        if (count === 0) {
            list.innerHTML = '<div class="empty-state">' +
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
                '<p>עדיין אין דפים</p><p style="font-size: 0.8rem; margin-top: 4px;">העלו תמונה כדי להתחיל</p></div>';
            return;
        }

        list.innerHTML = '';
        state.pages.forEach((page, idx) => {
            const item = document.createElement('div');
            item.className = 'page-item';
            item.innerHTML =
                '<div class="page-thumb"><img src="' + page.dataUrl + '" alt=""></div>' +
                '<div class="page-info"><div class="page-name">' + page.name + '</div>' +
                '<div class="page-meta">' + page.width + '×' + page.height + 'px</div></div>' +
                '<div class="page-actions">' +
                '<button class="page-btn" data-action="view" data-idx="' + idx + '" title="תצוגה"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button>' +
                '<button class="page-btn" data-action="up" data-idx="' + idx + '" title="העלה"' + (idx === 0 ? ' disabled' : '') + '><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg></button>' +
                '<button class="page-btn" data-action="down" data-idx="' + idx + '" title="הורד"' + (idx === state.pages.length - 1 ? ' disabled' : '') + '><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>' +
                '<button class="page-btn delete" data-action="delete" data-idx="' + idx + '" title="מחק"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>' +
                '</div>';
            list.appendChild(item);
        });
    }

    function handlePageAction(e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const idx = parseInt(btn.dataset.idx);
        if (isNaN(idx)) return;

        if (action === 'view') {
            $('previewImg').src = state.pages[idx].dataUrl;
            $('previewModal').classList.add('show');
        } else if (action === 'up' && idx > 0) {
            [state.pages[idx - 1], state.pages[idx]] = [state.pages[idx], state.pages[idx - 1]];
            renderPagesList();
        } else if (action === 'down' && idx < state.pages.length - 1) {
            [state.pages[idx + 1], state.pages[idx]] = [state.pages[idx], state.pages[idx + 1]];
            renderPagesList();
        } else if (action === 'delete') {
            state.pages.splice(idx, 1);
            renderPagesList();
            showToast('הדף נמחק');
        }
    }

    // ===== Export PDF =====
    function exportPDF() {
        if (state.pages.length === 0) return;
        showLoading('יוצר PDF...');
        try {
            const { jsPDF } = window.jspdf;
            let pdf = null;

            state.pages.forEach((page, i) => {
                const img = new Image();
                img.src = page.dataUrl;
                // We need to load synchronously, but since dataUrl is already loaded in pagesList
                // Use the existing data
                const orientation = page.width > page.height ? 'l' : 'p';
                if (i === 0) {
                    pdf = new jsPDF({
                        orientation: orientation,
                        unit: 'px',
                        format: [page.width, page.height],
                    });
                } else {
                    pdf.addPage([page.width, page.height], orientation);
                }
                pdf.addImage(page.dataUrl, 'PNG', 0, 0, page.width, page.height);
            });

            pdf.save('scan_' + Date.now() + '.pdf');
            showToast('PDF נוצר בהצלחה', 'success');
        } catch (err) {
            console.error('PDF export error:', err);
            showToast('שגיאה ביצירת PDF', 'error');
        } finally {
            hideLoading();
        }
    }

    function exportPNG() {
        if (state.pages.length === 0) return;
        showLoading('יוצא תמונות...');
        try {
            state.pages.forEach((page, i) => {
                const a = document.createElement('a');
                a.href = page.dataUrl;
                a.download = 'scan_' + (i + 1) + '_' + Date.now() + '.png';
                a.click();
            });
            showToast('התמונות יוצאו', 'success');
        } catch (err) {
            console.error('PNG export error:', err);
            showToast('שגיאה בייצוא', 'error');
        } finally {
            hideLoading();
        }
    }

    function clearAll() {
        state.pages = [];
        renderPagesList();
        showToast('כל הדפים נמחקו');
    }

    // ===== Camera =====
    async function openCamera() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: state.cameraFacing, width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio: false,
            });
            state.cameraStream = stream;
            $('cameraVideo').srcObject = stream;
            $('cameraModal').classList.add('show');
        } catch (err) {
            console.error('Camera error:', err);
            showToast('לא ניתן לגשת למצלמה', 'error');
        }
    }

    function closeCamera() {
        if (state.cameraStream) {
            state.cameraStream.getTracks().forEach(t => t.stop());
            state.cameraStream = null;
        }
        $('cameraModal').classList.remove('show');
    }

    function capturePhoto() {
        const video = $('cameraVideo');
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        closeCamera();

        const img = new Image();
        img.onload = () => {
            state.currentImage = img;
            state.rotation = 0;
            state.filter = 'grayscale';
            state.brightness = 0;
            state.contrast = 0;
            enterEditMode();
        };
        img.src = dataUrl;
    }

    async function switchCamera() {
        state.cameraFacing = state.cameraFacing === 'environment' ? 'user' : 'environment';
        closeCamera();
        await openCamera();
    }

    // ===== Event Listeners =====
    function init() {
        // File upload
        $('btnSelectFile').addEventListener('click', () => $('fileInput').click());
        $('fileInput').addEventListener('change', handleFileSelect);
        $('uploadZone').addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            $('fileInput').click();
        });

        // Drag & drop
        const zone = $('uploadZone');
        ['dragenter', 'dragover'].forEach(ev => {
            zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); });
        });
        ['dragleave', 'drop'].forEach(ev => {
            zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); });
        });
        zone.addEventListener('drop', (e) => {
            const files = e.dataTransfer.files;
            if (files && files.length > 0) loadImageFile(files[0]);
        });

        // Camera
        $('btnCamera').addEventListener('click', openCamera);
        $('btnCameraClose').addEventListener('click', closeCamera);
        $('btnCapture').addEventListener('click', capturePhoto);
        $('btnCameraSwitch').addEventListener('click', switchCamera);

        // Edit step
        $('btnAutoDetect').addEventListener('click', autoDetectCorners);
        $('btnResetCorners').addEventListener('click', () => {
            const src = state.currentImageCanvas;
            state.corners = [
                { x: 0, y: 0 },
                { x: src.width, y: 0 },
                { x: src.width, y: src.height },
                { x: 0, y: src.height },
            ];
            drawEditCanvas();
        });
        $('btnRotate').addEventListener('click', () => {
            state.rotation = (state.rotation + 90) % 360;
            prepareEditCanvas();
            autoDetectCorners();
        });
        $('btnBackToUpload').addEventListener('click', () => {
            showStep('upload');
            $('fileInput').value = '';
        });
        $('btnApplyCrop').addEventListener('click', async () => {
            await applyPerspectiveTransform();
            if (state.warpedCanvas) {
                showStep('filter');
                applyFilter();
            }
        });

        // Canvas interaction
        const canvas = $('editCanvas');
        canvas.addEventListener('mousedown', onCanvasDown);
        canvas.addEventListener('mousemove', onCanvasMove);
        canvas.addEventListener('mouseup', onCanvasUp);
        canvas.addEventListener('mouseleave', onCanvasUp);
        canvas.addEventListener('touchstart', onCanvasDown, { passive: false });
        canvas.addEventListener('touchmove', onCanvasMove, { passive: false });
        canvas.addEventListener('touchend', onCanvasUp);

        // Show hint on canvas interaction
        canvas.addEventListener('mousedown', () => {
            const hint = $('canvasHint');
            hint.classList.add('show');
            setTimeout(() => hint.classList.remove('show'), 2500);
        });

        // Filter step
        $('filterOptions').addEventListener('click', (e) => {
            const opt = e.target.closest('.filter-option');
            if (!opt) return;
            document.querySelectorAll('.filter-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            state.filter = opt.dataset.filter;
            applyFilter();
        });

        $('brightnessSlider').addEventListener('input', (e) => {
            state.brightness = parseInt(e.target.value);
            $('brightnessValue').textContent = state.brightness > 0 ? '+' + state.brightness : state.brightness;
            applyFilter();
        });

        $('contrastSlider').addEventListener('input', (e) => {
            state.contrast = parseInt(e.target.value);
            $('contrastValue').textContent = state.contrast > 0 ? '+' + state.contrast : state.contrast;
            applyFilter();
        });

        $('btnBackToEdit').addEventListener('click', () => showStep('edit'));
        $('btnAddAnother').addEventListener('click', () => {
            saveCurrentPage();
        });
        $('btnSavePage').addEventListener('click', saveCurrentPage);

        // Pages
        $('pagesList').addEventListener('click', handlePageAction);

        // Export
        $('btnExportPDF').addEventListener('click', exportPDF);
        $('btnExportPNG').addEventListener('click', exportPNG);
        $('btnClearAll').addEventListener('click', clearAll);

        // Preview modal
        $('btnClosePreview').addEventListener('click', () => $('previewModal').classList.remove('show'));
        $('btnDownloadSingle').addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = $('previewImg').src;
            a.download = 'scan_' + Date.now() + '.png';
            a.click();
        });
        $('previewModal').addEventListener('click', (e) => {
            if (e.target === $('previewModal')) $('previewModal').classList.remove('show');
        });

        // Header scroll
        window.addEventListener('scroll', () => {
            $('header').classList.toggle('scrolled', window.scrollY > 10);
        });

        // Preload OpenCV
        waitOpenCV().then(() => {
            console.log('OpenCV.js ready');
        });

        renderPagesList();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
