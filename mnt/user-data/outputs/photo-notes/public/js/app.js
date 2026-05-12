// Image preview on file select
document.addEventListener('DOMContentLoaded', () => {
  const imageInput = document.getElementById('image');
  const preview = document.getElementById('imagePreview');

  if (imageInput && preview) {
    imageInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          preview.innerHTML = `<img src="${ev.target.result}" alt="Preview">`;
        };
        reader.readAsDataURL(file);
      } else {
        preview.innerHTML = '';
      }
    });
  }
});
