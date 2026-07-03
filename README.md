# Print Image AR Starter

เว็บตัวอย่างสำหรับทดลองงาน AR แบบ image tracking:

- ส่องรูป `assets/target-image.png`
- แล้วแสดงวิดีโอ `assets/overlay-video.mp4` ทับบนรูปแบบ AR

## โครงไฟล์

```text
print-image-ar-starter/
  index.html
  assets/
    target-image.png
    source-animation.png
    overlay-video.mp4
    targets.mind   ← ต้องสร้างเองจาก target-image.png
```

## ขั้นตอนที่ต้องทำก่อนรันจริง

1. เปิด MindAR Image Targets Compiler
2. อัปโหลด `assets/target-image.png`
3. ดาวน์โหลดไฟล์ `.mind`
4. เปลี่ยนชื่อเป็น `targets.mind`
5. วางไว้ที่ `assets/targets.mind`

ถ้ายังไม่มี `assets/targets.mind` เว็บจะยังส่องรูปไม่ติด เพราะ MindAR ยังไม่มีข้อมูลจำภาพ

## รันทดสอบในเครื่อง

```bash
python -m http.server 8080
```

จากนั้นเปิด:

```text
http://localhost:8080
```

บนมือถือจริงควรใช้ HTTPS เช่น Netlify, GitHub Pages, Cloudflare Pages หรือ Vercel เพราะ browser จะอนุญาตกล้องเฉพาะ secure context เป็นหลัก

## Deploy แบบง่าย

- สร้าง `assets/targets.mind` ให้เรียบร้อยก่อน
- Zip หรือ drag ทั้งโฟลเดอร์ขึ้น Netlify
- เอาลิงก์เว็บไปทำ QR code
- ปริ้น `assets/target-image.png` + QR code

