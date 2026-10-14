/* Keep the pre-start Live form aligned with its source and runtime requirements. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const sourceType = $('liveSourceType');
  const fileField = $('liveSourceFileField');
  const pathField = $('liveSourcePathField');
  const source = $('liveSource');
  const sourceFile = $('liveSourceFile');
  const sourceName = $('liveSourceFileName');
  const sourceLabel = $('liveSourceLabel');
  const sourceHelp = $('liveSourceHelp');
  const device = $('liveDevice');
  const cudaOption = device && device.querySelector('option[value="cuda"]');
  const deviceHelp = $('liveDeviceHelp');
  const runtimeStatus = $('liveRuntimeStatus');
  const start = $('liveStart');
  const status = $('liveRealStatus');
  if (!sourceType || !start) return;

  let cudaAvailable = null;
  let uploadEndpointMissing = false;
  const maxBytes = 100 * 1024 * 1024;
  const allowedExt = new Set(['.mp4', '.avi', '.mov', '.mkv']);

  function report(text) {
    if (status) status.textContent = text;
  }

  function syncSourceMode() {
    const isFile = sourceType.value === 'file';
    if (fileField) fileField.hidden = !isFile;
    if (pathField) pathField.hidden = isFile;
    if (sourceLabel) sourceLabel.textContent = isFile ? '2. เลือกไฟล์วิดีโอ' : '2. URL กล้อง RTSP';
    if (source) source.placeholder = isFile ? 'เลือกไฟล์วิดีโอจากเครื่อง' : 'rtsp://กล้องในเครือข่าย/stream';
    if (sourceHelp) {
      sourceHelp.textContent = isFile
        ? 'เลือกวิดีโอจากเครื่องเพื่อ replay · อัปโหลดเป็นไฟล์ชั่วคราวและลบเมื่อ session จบ · MP4, AVI, MOV, MKV ไม่เกิน 100 MB'
        : 'กรอก URL ของกล้อง RTSP ที่เครื่องนี้เข้าถึงได้ · URL ที่มีรหัสผ่านเป็นข้อมูลลับ อย่าแชร์หรือโพสต์ในที่สาธารณะ';
    }
  }

  function updateDeviceHelp() {
    if (!deviceHelp) return;
    if (device.value === 'cuda') {
      if (cudaAvailable === false) {
        deviceHelp.textContent = 'ยังใช้ GPU ไม่ได้: PyTorch ใน runtime นี้ไม่พบ CUDA · เลือก Auto หรือ CPU';
        deviceHelp.style.color = '#fca5a5';
      } else if (cudaAvailable === true) {
        deviceHelp.textContent = 'YOLO/X3D ใช้ GPU · YuNet อาจยังใช้ CPU';
        deviceHelp.style.color = 'var(--muted2)';
      } else {
        deviceHelp.textContent = 'ยังตรวจ CUDA ไม่สำเร็จ · กดเริ่มเพื่อลองตรวจอีกครั้ง';
      }
    } else if (device.value === 'auto' && cudaAvailable === true) {
      deviceHelp.textContent = 'Auto เลือก GPU ให้ YOLO/X3D เมื่อพร้อม · YuNet อาจใช้ CPU';
      deviceHelp.style.color = 'var(--muted2)';
    } else if (device.value === 'auto' && cudaAvailable === false) {
      deviceHelp.textContent = 'Auto ใช้ CPU เพราะ runtime นี้ไม่พบ PyTorch CUDA';
      deviceHelp.style.color = 'var(--muted2)';
    } else {
      deviceHelp.textContent = 'ทุกเครื่องใช้ CPU ได้';
      deviceHelp.style.color = 'var(--muted2)';
    }
  }

  sourceType.addEventListener('change', syncSourceMode);
  if (device) device.addEventListener('change', updateDeviceHelp);
  if (sourceFile) sourceFile.addEventListener('change', () => {
    const file = sourceFile.files && sourceFile.files[0];
    if (sourceName) sourceName.textContent = file
      ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`
      : 'ยังไม่ได้เลือกไฟล์';
  });

  // Capture phase prevents a bad request from uploading the whole clip first.
  start.addEventListener('click', event => {
    if(window.CCTVMode.active)return;
    const fileMode = sourceType.value === 'file';
    if (fileMode) {
      if (uploadEndpointMissing) {
        event.preventDefault(); event.stopImmediatePropagation();
        report('API ยังไม่มี endpoint อัปโหลด Live · หยุดและเปิด Uvicorn จาก .venv-test ใหม่');
        return;
      }
      const file = sourceFile && sourceFile.files && sourceFile.files[0];
      if (!file) {
        event.preventDefault(); event.stopImmediatePropagation();
        report('กรุณาเลือกไฟล์วิดีโอก่อนเริ่ม Live');
        if (sourceFile) sourceFile.focus();
        return;
      }
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      if (!allowedExt.has(ext)) {
        event.preventDefault(); event.stopImmediatePropagation();
        report('ไฟล์นี้ยังไม่รองรับ · เลือก MP4, AVI, MOV หรือ MKV');
        return;
      }
      if (file.size > maxBytes) {
        event.preventDefault(); event.stopImmediatePropagation();
        report('ไฟล์ใหญ่เกินไป · ขนาดสูงสุด 100 MB');
        return;
      }
    } else if (!source || !source.value.trim()) {
      event.preventDefault(); event.stopImmediatePropagation();
      report('กรุณากรอก RTSP URL ก่อนเริ่ม Live');
      if (source) source.focus();
      return;
    }
    if (device && device.value === 'cuda' && cudaAvailable === false) {
      event.preventDefault(); event.stopImmediatePropagation();
      report('เริ่มไม่ได้เพราะ PyTorch runtime ไม่พบ CUDA · เลือก Auto หรือ CPU');
    }
  }, true);

  syncSourceMode();
  updateDeviceHelp();
  let runtimeGeneration=0;
  function loadRuntime(){
    const token=++runtimeGeneration;
    if(window.CCTVMode.active){runtimeStatus.textContent='โหมดสาธิต · ไม่ได้รัน YOLO/X3D/YuNet';deviceHelp.textContent='ไม่ได้เลือกอุปกรณ์ประมวลผลจริง';return;}
  window.CCTVMode.fetch('/api/health').then(async response => {
    const body = await response.json();
    if(token!==runtimeGeneration)return;
    if (!response.ok || !body.runtime) throw new Error('API health unavailable');
    cudaAvailable = Boolean(body.runtime.cuda_available);
    if (cudaOption) cudaOption.disabled = !cudaAvailable;
    if (!cudaAvailable && device.value === 'cuda') {
      device.value = 'auto';
      report('runtime นี้ไม่มี CUDA · เปลี่ยนเป็น Auto ซึ่งจะใช้ CPU');
    }
    const gpuName = body.runtime.gpu && body.runtime.gpu.name ? ` · ${body.runtime.gpu.name}` : '';
    const uploadRoute = await window.CCTVMode.fetch('/api/live/start-upload', { method: 'OPTIONS' });
    if(token!==runtimeGeneration)return;
    uploadEndpointMissing = uploadRoute.status === 404;
    runtimeStatus.textContent = uploadEndpointMissing
      ? 'API รุ่นเก่า · ไม่พบ file-upload route · รีสตาร์ต Uvicorn'
      : cudaAvailable ? `API พร้อม · YOLO/X3D ใช้ CUDA${gpuName} · YuNet ใช้ CPU` : 'API พร้อม · ใช้ CPU';
    if (uploadEndpointMissing && sourceType.value === 'file') {
      report('ต้องรีสตาร์ต backend เพื่อเปิดใช้การเลือกไฟล์ Live');
    }
    runtimeStatus.style.color = uploadEndpointMissing ? '#fca5a5' : 'var(--muted)';
    updateDeviceHelp();
  }).catch(() => {
    if(token!==runtimeGeneration)return;
    cudaAvailable = null;
    runtimeStatus.textContent = 'ตรวจสถานะ API ไม่ได้ · ตรวจว่า backend ทำงานอยู่';
    runtimeStatus.style.color = '#fca5a5';
    updateDeviceHelp();
  });
  }
  document.addEventListener('cctv:modechange',loadRuntime);
  loadRuntime();
}());
