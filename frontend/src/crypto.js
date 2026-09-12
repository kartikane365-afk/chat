// Utility for E2EE using Web Crypto API

// Generate a key pair for a new user
export async function generateKeyPair() {
  const keyPair = await window.crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"]
  );

  const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateKeyJwk = await window.crypto.subtle.exportKey("jwk", keyPair.privateKey);

  return { publicKeyJwk, privateKeyJwk };
}

// Encrypt a message using the recipient's public key
export async function encryptMessage(text, recipientPublicKeyJwk) {
  const publicKey = await window.crypto.subtle.importKey(
    "jwk",
    recipientPublicKeyJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );

  const encodedText = new TextEncoder().encode(text);
  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    encodedText
  );

  // Convert ArrayBuffer to Base64
  return btoa(String.fromCharCode(...new Uint8Array(encryptedBuffer)));
}

// Decrypt a message using the user's private key
export async function decryptMessage(encryptedBase64, privateKeyJwk) {
  try {
    const privateKey = await window.crypto.subtle.importKey(
      "jwk",
      privateKeyJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"]
    );

    // Convert Base64 back to ArrayBuffer
    const encryptedBytes = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      encryptedBytes
    );

    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) {
    console.error("Decryption failed", err);
    throw err;
  }
}

// --- FILE ENCRYPTION (E2EE Media) ---

export async function encryptFile(file) {
  // Generate a random 256-bit AES key
  const aesKey = await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
  );
  // Initialization vector
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const fileBuffer = await file.arrayBuffer();
  
  // Encrypt the file binary data
  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv }, aesKey, fileBuffer
  );
  
  const exportedKey = await window.crypto.subtle.exportKey("raw", aesKey);
  
  // Pack the IV and Key together so we can send it in the text message
  const keyAndIv = new Uint8Array(exportedKey.byteLength + iv.byteLength);
  keyAndIv.set(new Uint8Array(exportedKey), 0);
  keyAndIv.set(iv, exportedKey.byteLength);
  const keyBase64 = btoa(String.fromCharCode(...keyAndIv));

  return { 
    encryptedBlob: new Blob([encryptedBuffer], {type: file.type}), 
    keyBase64 
  };
}

export async function decryptFile(encryptedBlob, keyBase64, mimeType) {
  const keyAndIv = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
  const rawKey = keyAndIv.slice(0, 32);
  const iv = keyAndIv.slice(32);

  const aesKey = await window.crypto.subtle.importKey(
    "raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]
  );

  const encryptedBuffer = await encryptedBlob.arrayBuffer();
  
  const decryptedBuffer = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv }, aesKey, encryptedBuffer
  );

  return new Blob([decryptedBuffer], { type: mimeType });
}
