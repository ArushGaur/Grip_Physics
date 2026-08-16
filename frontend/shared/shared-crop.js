        /* ══════════════════════════════════════════════════════════════════
           CROP SYSTEM — Canvas-based, fully redrawn
        ══════════════════════════════════════════════════════════════════ */
        let impCropState = {
            qIndex: -1, sourceIdx: 0, zoom: 1,
            drag: null,     // { startX, startY } in image coords
            sel: null,      // { x, y, w, h } in image coords
            panning: false, panStart: null, scrollStart: null,
            img: null,      // loaded HTMLImageElement
            mode: 'q',      // 'q' = question diagram, 'sol' = solution image, 'opt' = option image
            solQIndex: -1,  // question index when mode === 'sol'
            solSolIdx: 0,   // which solution entry to update
            optQIndex: -1,  // question index when mode === 'opt'
            optIndex: -1,   // which option (0-3) to update when mode === 'opt'
        };
        
        function _impGetCropImages() {
            return impCropState.mode === 'sol' ? _impSolScreenshots : impQImages;
        }

        function impOpenCropModal(qi, preferredSrcIdx = -1) {
            if (!impQImages.length) {
                showErrorModal("Upload at least one question screenshot before cropping.", "No screenshots");
                return;
            }
            impCropState.mode = 'q';
            impCropState.qIndex = qi;
            impCropState.sourceIdx = preferredSrcIdx >= 0
                ? Math.min(preferredSrcIdx, impQImages.length - 1) : 0;
            impCropState.zoom = 1;
            impCropState.drag = null;
            impCropState.sel = null;

            // Update modal title
            const titleEl = document.querySelector('#impCropModal .imp-crop-header div:first-child div:first-child');
            if (titleEl) titleEl.textContent = '✂ Crop Diagram';

            // Build thumbnail rail
            const rail = document.getElementById("impCropRail");
            rail.innerHTML = '<div class="imp-crop-rail-label">Screenshots</div>';
            impQImages.forEach((b64, idx) => {
                const btn = document.createElement("div");
                btn.className = `imp-crop-thumb${idx === impCropState.sourceIdx ? " active" : ""}`;
                btn.innerHTML = `<img src="${impB64ToDataUrl(b64)}" alt="Screenshot ${idx + 1}" draggable="false"><div class="imp-crop-thumb-label">Screenshot ${idx + 1}</div>`;
                btn.onclick = () => impSetCropSource(idx);
                rail.appendChild(btn);
            });

            document.getElementById("impCropApplyBtn").disabled = true;
            document.getElementById("impCropCoords").textContent = "No selection — drag on the image";
            document.getElementById("impCropZoom").value = "1";
            document.getElementById("impCropZoomLabel").textContent = "100%";
            document.getElementById("impCropModal").style.display = "flex";
            impCropLoadImage(impCropState.sourceIdx);
            impInitCropEvents();
        }

        /* ── Open crop modal for a SOLUTION image ────────────────────────── */
        function impOpenSolCropModal(qi, solSolIdx = 0, preferredSrcIdx = -1) {
            if (!_impSolScreenshots.length) {
                showErrorModal("Upload at least one solution screenshot before cropping.", "No solution screenshots");
                return;
            }
            impCropState.mode = 'sol';
            impCropState.solQIndex = qi;
            impCropState.solSolIdx = solSolIdx;
            impCropState.qIndex = -1; // not used in sol mode
            impCropState.sourceIdx = preferredSrcIdx >= 0
                ? Math.min(preferredSrcIdx, _impSolScreenshots.length - 1) : 0;
            impCropState.zoom = 1;
            impCropState.drag = null;
            impCropState.sel = null;

            // Update modal title
            const titleEl = document.querySelector('#impCropModal .imp-crop-header div:first-child div:first-child');
            if (titleEl) titleEl.textContent = '✂ Crop Solution Image';

            // Build thumbnail rail from solution screenshots
            const rail = document.getElementById("impCropRail");
            rail.innerHTML = '<div class="imp-crop-rail-label">Solution Screenshots</div>';
            _impSolScreenshots.forEach((b64, idx) => {
                const btn = document.createElement("div");
                btn.className = `imp-crop-thumb${idx === impCropState.sourceIdx ? " active" : ""}`;
                btn.innerHTML = `<img src="${impB64ToDataUrl(b64)}" alt="Solution ${idx + 1}" draggable="false"><div class="imp-crop-thumb-label">Sol. ${idx + 1}</div>`;
                btn.onclick = () => impSetCropSource(idx);
                rail.appendChild(btn);
            });

            document.getElementById("impCropApplyBtn").disabled = true;
            document.getElementById("impCropCoords").textContent = "No selection — drag on the image";
            document.getElementById("impCropZoom").value = "1";
            document.getElementById("impCropZoomLabel").textContent = "100%";
            document.getElementById("impCropModal").style.display = "flex";
            impCropLoadImage(impCropState.sourceIdx);
            impInitCropEvents();
        }

        /* ── Open crop modal for an OPTION image ────────────────────────── */
        function impOpenOptCropModal(qi, oi, preferredSrcIdx = -1) {
            if (!impQImages.length) {
                showErrorModal("Upload at least one question screenshot before cropping.", "No screenshots");
                return;
            }
            impCropState.mode = 'opt';
            impCropState.optQIndex = qi;
            impCropState.optIndex = oi;
            impCropState.qIndex = -1;
            impCropState.sourceIdx = preferredSrcIdx >= 0
                ? Math.min(preferredSrcIdx, impQImages.length - 1) : 0;
            impCropState.zoom = 1;
            impCropState.drag = null;
            impCropState.sel = null;

            // Update modal title
            const titleEl = document.querySelector('#impCropModal .imp-crop-header div:first-child div:first-child');
            if (titleEl) titleEl.textContent = `\u2702 Crop Option ${['A', 'B', 'C', 'D'][oi] || oi + 1} Diagram`;

            // Build thumbnail rail from question screenshots
            const rail = document.getElementById("impCropRail");
            rail.innerHTML = '<div class="imp-crop-rail-label">Screenshots</div>';
            impQImages.forEach((b64, idx) => {
                const btn = document.createElement("div");
                btn.className = `imp-crop-thumb${idx === impCropState.sourceIdx ? " active" : ""}`;
                btn.innerHTML = `<img src="${impB64ToDataUrl(b64)}" alt="Screenshot ${idx + 1}" draggable="false"><div class="imp-crop-thumb-label">Screenshot ${idx + 1}</div>`;
                btn.onclick = () => impSetCropSource(idx);
                rail.appendChild(btn);
            });

            document.getElementById("impCropApplyBtn").disabled = true;
            document.getElementById("impCropCoords").textContent = "No selection — drag on the image";
            document.getElementById("impCropZoom").value = "1";
            document.getElementById("impCropZoomLabel").textContent = "100%";
            document.getElementById("impCropModal").style.display = "flex";
            impCropLoadImage(impCropState.sourceIdx);
            impInitCropEvents();
        }

        function impCloseCropModal() {
            document.getElementById("impCropModal").style.display = "none";
            impRemoveCropEvents();
            impCropState.drag = null;
            impCropState.sel = null;
        }

        function impSetCropSource(idx) {
            const imgs = _impGetCropImages();
            impCropState.sourceIdx = Math.max(0, Math.min(idx, imgs.length - 1));
            document.querySelectorAll(".imp-crop-thumb").forEach((el, i) =>
                el.classList.toggle("active", i === impCropState.sourceIdx));
            impCropState.sel = null;
            impCropState.drag = null;
            document.getElementById("impCropApplyBtn").disabled = true;
            document.getElementById("impCropCoords").textContent = "No selection — drag on the image";
            impCropLoadImage(impCropState.sourceIdx);
        }

        function impCropLoadImage(idx) {
            const imgs = _impGetCropImages();
            const img = new Image();
            img.onload = () => {
                impCropState.img = img;
                impCropZoomFit();
            };
            img.src = impB64ToDataUrl(imgs[idx]);
        }

        function impSetCropZoom(val) {
            const z = parseFloat(val);
            impCropState.zoom = isFinite(z) ? Math.max(0.3, Math.min(4, z)) : 1;
            document.getElementById("impCropZoomLabel").textContent = `${Math.round(impCropState.zoom * 100)}%`;
            impCropDraw();
        }

        function impCropZoomFit() {
            const wrap = document.getElementById("impCropCanvasWrap");
            const img = impCropState.img;
            if (!img || !wrap) return;
            const ww = wrap.clientWidth - 24, wh = wrap.clientHeight - 24;
            const zoomW = ww / img.naturalWidth, zoomH = wh / img.naturalHeight;
            impCropState.zoom = Math.min(Math.max(zoomW, zoomH, 0.3), 4);
            const zSlider = document.getElementById("impCropZoom");
            if (zSlider) zSlider.value = String(impCropState.zoom);
            document.getElementById("impCropZoomLabel").textContent = `${Math.round(impCropState.zoom * 100)}%`;
            impCropDraw();
        }

        function impResetCropSel() {
            impCropState.sel = null;
            impCropState.drag = null;
            document.getElementById("impCropApplyBtn").disabled = true;
            document.getElementById("impCropCoords").textContent = "No selection — drag on the image";
            impCropDraw();
        }

        function impCropDraw() {
            const canvas = document.getElementById("impCropCanvas");
            const img = impCropState.img;
            if (!canvas || !img) return;
            const z = impCropState.zoom;
            const W = Math.round(img.naturalWidth * z);
            const H = Math.round(img.naturalHeight * z);
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, W, H);
            ctx.drawImage(img, 0, 0, W, H);

            const sel = impCropState.sel;
            if (sel && sel.w > 0 && sel.h > 0) {
                const sx = sel.x * z, sy = sel.y * z, sw = sel.w * z, sh = sel.h * z;
                // Darken outside
                ctx.fillStyle = "rgba(0,0,0,0.45)";
                ctx.fillRect(0, 0, W, sy);
                ctx.fillRect(0, sy + sh, W, H - sy - sh);
                ctx.fillRect(0, sy, sx, sh);
                ctx.fillRect(sx + sw, sy, W - sx - sw, sh);
                // Selection border
                ctx.strokeStyle = "#56a9ff";
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 3]);
                ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
                ctx.setLineDash([]);
                // Handles
                const hs = 8;
                const corners = [[sx, sy], [sx + sw, sy], [sx, sy + sh], [sx + sw, sy + sh]];
                ctx.fillStyle = "#fff";
                corners.forEach(([cx, cy]) => {
                    ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
                    ctx.strokeStyle = "#56a9ff"; ctx.lineWidth = 1.5;
                    ctx.strokeRect(cx - hs / 2, cy - hs / 2, hs, hs);
                });
                // Size label
                const lbl = `${Math.round(sel.w)} × ${Math.round(sel.h)} px`;
                ctx.font = "bold 12px 'Outfit', sans-serif";
                const tw = ctx.measureText(lbl).width;
                const lx = Math.min(sx, W - tw - 10), ly = Math.max(sy - 8, 14);
                ctx.fillStyle = "#56a9ff";
                ctx.fillRect(lx - 4, ly - 12, tw + 8, 18);
                ctx.fillStyle = "#fff";
                ctx.fillText(lbl, lx, ly);
            }
        }

        function impCropCanvasToImg(clientX, clientY) {
            const canvas = document.getElementById("impCropCanvas");
            const rect = canvas.getBoundingClientRect();
            return {
                x: (clientX - rect.left) / impCropState.zoom,
                y: (clientY - rect.top) / impCropState.zoom,
            };
        }

        let _impCropHandlers = null;
        function impInitCropEvents() {
            if (_impCropHandlers) impRemoveCropEvents();
            const wrap = document.getElementById("impCropCanvasWrap");
            const canvas = document.getElementById("impCropCanvas");
            if (!wrap || !canvas) return;

            function getPoint(e) {
                const src = e.touches ? e.touches[0] : e;
                return impCropCanvasToImg(src.clientX, src.clientY);
            }

            function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

            function onDown(e) {
                if (e.button !== undefined && e.button !== 0) return;
                e.preventDefault();
                const p = getPoint(e);
                const img = impCropState.img;
                if (!img) return;
                // clamp to image bounds
                impCropState.drag = {
                    startX: clamp(p.x, 0, img.naturalWidth),
                    startY: clamp(p.y, 0, img.naturalHeight),
                };
                impCropState.sel = null;
            }

            function onMove(e) {
                if (!impCropState.drag) return;
                e.preventDefault();
                const p = getPoint(e);
                const img = impCropState.img;
                if (!img) return;
                const cx = clamp(p.x, 0, img.naturalWidth);
                const cy = clamp(p.y, 0, img.naturalHeight);
                const x = Math.min(impCropState.drag.startX, cx);
                const y = Math.min(impCropState.drag.startY, cy);
                const w = Math.abs(cx - impCropState.drag.startX);
                const h = Math.abs(cy - impCropState.drag.startY);
                impCropState.sel = { x, y, w, h };
                impCropDraw();
                const coords = document.getElementById("impCropCoords");
                if (coords) coords.textContent = `x:${Math.round(x)} y:${Math.round(y)} → ${Math.round(w)}×${Math.round(h)}px`;
            }

            function onUp(e) {
                if (!impCropState.drag) return;
                impCropState.drag = null;
                const sel = impCropState.sel;
                const applyBtn = document.getElementById("impCropApplyBtn");
                if (sel && sel.w > 8 && sel.h > 8) {
                    if (applyBtn) applyBtn.disabled = false;
                } else {
                    impCropState.sel = null;
                    if (applyBtn) applyBtn.disabled = true;
                    const coords = document.getElementById("impCropCoords");
                    if (coords) coords.textContent = "Selection too small — try again";
                    impCropDraw();
                }
            }

            canvas.addEventListener("mousedown", onDown);
            canvas.addEventListener("mousemove", onMove);
            canvas.addEventListener("mouseup", onUp);
            canvas.addEventListener("mouseleave", onUp);
            canvas.addEventListener("touchstart", onDown, { passive: false });
            canvas.addEventListener("touchmove", onMove, { passive: false });
            canvas.addEventListener("touchend", onUp);
            _impCropHandlers = { canvas, onDown, onMove, onUp };
        }

        function impRemoveCropEvents() {
            if (!_impCropHandlers) return;
            const { canvas, onDown, onMove, onUp } = _impCropHandlers;
            canvas.removeEventListener("mousedown", onDown);
            canvas.removeEventListener("mousemove", onMove);
            canvas.removeEventListener("mouseup", onUp);
            canvas.removeEventListener("mouseleave", onUp);
            canvas.removeEventListener("touchstart", onDown);
            canvas.removeEventListener("touchmove", onMove);
            canvas.removeEventListener("touchend", onUp);
            _impCropHandlers = null;
        }

        async function impApplyCrop() {
            const sel = impCropState.sel;
            const img = impCropState.img;
            if (!sel || sel.w < 8 || sel.h < 8 || !img) {
                showErrorModal("Please draw a selection rectangle first.", "No selection");
                return;
            }

            const x = Math.max(0, Math.round(sel.x));
            const y = Math.max(0, Math.round(sel.y));
            const w = Math.min(img.naturalWidth - x, Math.round(sel.w));
            const h = Math.min(img.naturalHeight - y, Math.round(sel.h));
            if (w < 4 || h < 4) { showErrorModal("Selection too small.", "Error"); return; }

            const cropC = document.createElement("canvas");
            cropC.width = w; cropC.height = h;
            cropC.getContext("2d").drawImage(img, x, y, w, h, 0, 0, w, h);

            if (impIsOpenCVReady()) {
                try {
                    const src = cv.imread(cropC);
                    const gray = new cv.Mat(); const out = new cv.Mat();
                    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
                    const brightness = cv.mean(gray)[0];
                    if (brightness < 55 || brightness > 205) {
                        const clahe = new cv.CLAHE(2.5, new cv.Size(8, 8));
                        const eq = new cv.Mat();
                        clahe.apply(gray, eq);
                        cv.cvtColor(eq, out, cv.COLOR_GRAY2RGBA);
                        eq.delete(); clahe.delete();
                    } else {
                        const k = cv.matFromArray(3, 3, cv.CV_32F,
                            [0, -0.5, 0, -0.5, 3, -0.5, 0, -0.5, 0]);
                        cv.filter2D(src, out, cv.CV_8U, k, new cv.Point(-1, -1), 0, cv.BORDER_DEFAULT);
                        k.delete();
                    }
                    cv.imshow(cropC, out);
                    src.delete(); gray.delete(); out.delete();
                } catch (_) { /* use plain crop */ }
            }

            const b64 = cropC.toDataURL("image/jpeg", 0.93).split(",")[1];

            if (impCropState.mode === 'sol') {
                /* ── Solution image crop ────────────────────────────────── */
                const qi = impCropState.solQIndex;
                const sIdx = impCropState.solSolIdx;
                const q = impQuestions[qi];
                if (!q) { impCloseCropModal(); return; }
                if (!q.solutions) q.solutions = [];
                if (!q.solutions[sIdx]) q.solutions[sIdx] = {};
                q.solutions[sIdx].image = b64;
                // Also update images[] array so impBuildSolutionHTML renders it
                if (!Array.isArray(q.solutions[sIdx].images)) q.solutions[sIdx].images = [];
                if (!q.solutions[sIdx].images.includes(b64)) q.solutions[sIdx].images.unshift(b64);
                q.solutions[sIdx].hasDiagram = true;

                // Refresh the solution block in the DOM
                const solBlock = document.getElementById(`impSolBlock_${qi}`);
                if (solBlock) {
                    solBlock.innerHTML = impBuildSolutionHTML(q.solutions, qi);
                    setTimeout(() => solBlock.querySelectorAll('.imp-sol-text').forEach(t => renderMath(t)), 0);
                }
            } else if (impCropState.mode === 'opt') {
                /* ── Option image crop ──────────────────────────────────── */
                const qi = impCropState.optQIndex;
                const oi = impCropState.optIndex;
                const q = impQuestions[qi];
                if (!q || oi < 0 || oi > 3) { impCloseCropModal(); return; }
                if (!Array.isArray(q.optionImages)) q.optionImages = [null, null, null, null];
                while (q.optionImages.length < 4) q.optionImages.push(null);
                q.optionImages[oi] = b64;
                q.hasOptionImages = true;

                // Update preview in DOM
                const previewId = `impOptImgPreview_${qi}_${oi}`;
                const existingPreview = document.getElementById(previewId);
                if (existingPreview) {
                    existingPreview.innerHTML = `<img src="${impB64ToDataUrl(b64)}" style="max-width:100%;max-height:90px;border-radius:4px;object-fit:contain;margin-top:4px" alt="Option ${['A', 'B', 'C', 'D'][oi]} diagram">
                        <button onclick="impRemoveOptImg(${qi},${oi})" style="background:none;border:none;color:var(--error);cursor:pointer;font-size:0.7rem;text-decoration:underline;font-family:inherit;margin-top:2px">✕ Remove</button>`;
                    existingPreview.style.display = 'block';
                }
                // Update crop button label
                const cropBtnId = `impOptCropBtn_${qi}_${oi}`;
                const cropBtn = document.getElementById(cropBtnId);
                if (cropBtn) cropBtn.textContent = '✂ Re-crop';
            } else {
                /* ── Question diagram crop (original behaviour) ─────────── */
                const qi = impCropState.qIndex;
                if (!Number.isInteger(qi) || !impQuestions[qi]) {
                    showErrorModal("Question not found.", "Error");
                    impCloseCropModal(); return;
                }
                impSetDiagramImage(qi, b64);
                impQuestions[qi].hasImage = true;
                impQuestions[qi].imageSourceIndex = impCropState.sourceIdx;
            }

            impCloseCropModal();
        }


