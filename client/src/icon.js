// App icon scene: Nova the astronaut holding a moving box, three-quarter view, framed tight for the plain icons and pulled back for the maskable ones.
import * as THREE from 'three';
import * as VX from './voxel.js';

const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
r.setPixelRatio(1); r.setSize(1024, 1024); r.setClearColor(0x000000, 0); r.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(r.domElement);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xfff4e6, 0x7a3a14, 2.1));
const key = new THREE.DirectionalLight(0xffffff, 1.9); key.position.set(2.5, 4, 5); scene.add(key);
const rim = new THREE.DirectionalLight(0xffd2a0, 0.8); rim.position.set(-4, 2, -3); scene.add(rim);
const nova = VX.makeMover('nova');
nova.children.filter(c => c.userData.blob).forEach(c => { c.visible = false; }); // the page draws its own soft shadow
const body = nova.userData.body;
body.rotation.y = 0.42;
body.traverse(o => { if (o.userData.arm !== undefined) o.rotation.x = -1.3; });
const box = VX.makeItem('fragile'); box.scale.setScalar(0.62); box.position.set(0, 0.2, 0.42); body.add(box);
scene.add(nova);
// ?mask=1 pulls back so Nova sits inside the 80% safe circle Android crops maskable icons to
const mask = new URLSearchParams(location.search).has('mask');
const cam = new THREE.PerspectiveCamera(mask ? 36 : 26, 1, 0.1, 50);
cam.position.set(0.9, 1.55, 4.3); cam.lookAt(0, 0.86, 0);
await new Promise(res => setTimeout(res, 600));
r.render(scene, cam);
document.body.dataset.done = 1;
