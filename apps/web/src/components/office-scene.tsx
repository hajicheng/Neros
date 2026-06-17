'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'

import { useAgentList } from '@/stores/app-store'

export function OfficeScene() {
  const mountRef = useRef<HTMLDivElement>(null)
  const agentCount = useAgentList().length

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const baseWorkstationCount = 6
    const workstationCount = baseWorkstationCount + agentCount
    const columns = 3
    const rows = Math.ceil(workstationCount / columns)
    const columnGap = 4
    const rowGap = 3.75
    const frustumSize = Math.max(8.6, rows * rowGap + 2.6)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf6f6f3)
    scene.fog = new THREE.Fog(0xf6f6f3, 13, 28 + rows * 3)

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    camera.position.set(0, 6.2 + Math.max(0, rows - 2) * 0.5, 8.4 + Math.max(0, rows - 2) * 0.65)
    camera.lookAt(0, 0.9, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.16
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.domElement.dataset.officeSceneCanvas = 'true'
    renderer.domElement.className = 'block size-full'
    mount.appendChild(renderer.domElement)

    const white = new THREE.MeshStandardMaterial({
      color: 0xf4f3ef,
      roughness: 0.68,
      metalness: 0.02,
    })
    const softWhite = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.62,
      metalness: 0.01,
    })
    const metal = new THREE.MeshStandardMaterial({
      color: 0xd4d1ca,
      roughness: 0.45,
      metalness: 0.24,
    })
    const screen = new THREE.MeshStandardMaterial({
      color: 0x111111,
      roughness: 0.4,
      metalness: 0.08,
    })
    const seam = new THREE.MeshStandardMaterial({
      color: 0xd8d7d2,
      roughness: 0.7,
      metalness: 0.02,
    })

    const addBox = (
      parent: THREE.Object3D,
      size: [number, number, number],
      position: [number, number, number],
      material: THREE.Material,
    ) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
      mesh.position.set(...position)
      mesh.castShadow = true
      mesh.receiveShadow = true
      parent.add(mesh)
      return mesh
    }

    const addCylinder = (
      parent: THREE.Object3D,
      radius: number,
      height: number,
      position: [number, number, number],
      material: THREE.Material,
      radialSegments = 32,
    ) => {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, height, radialSegments),
        material,
      )
      mesh.position.set(...position)
      mesh.castShadow = true
      mesh.receiveShadow = true
      parent.add(mesh)
      return mesh
    }

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(26, Math.max(20, rows * rowGap + 8)),
      new THREE.ShadowMaterial({ color: 0x8f8c82, opacity: 0.16 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.02
    floor.receiveShadow = true
    scene.add(floor)

    scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d3c7, 2.5))

    const keyLight = new THREE.DirectionalLight(0xffffff, 4.3)
    keyLight.position.set(-5.5, 8.5, 7)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(2048, 2048)
    keyLight.shadow.camera.near = 0.5
    keyLight.shadow.camera.far = 24
    keyLight.shadow.camera.left = -9
    keyLight.shadow.camera.right = 9
    keyLight.shadow.camera.top = 8 + Math.max(0, rows - 2) * 1.4
    keyLight.shadow.camera.bottom = -8 - Math.max(0, rows - 2) * 1.4
    scene.add(keyLight)

    const rimLight = new THREE.DirectionalLight(0xffffff, 1.2)
    rimLight.position.set(6, 5, -5)
    scene.add(rimLight)

    const createWorkstation = (x: number, z: number) => {
      const station = new THREE.Group()
      station.position.set(x, 0, z)
      scene.add(station)

      addBox(station, [2.45, 0.18, 1.36], [0, 1.48, 0], softWhite)
      addBox(station, [2.55, 0.07, 1.46], [0, 1.37, 0], white)
      addBox(station, [0.07, 1.32, 0.07], [-1.08, 0.68, 0.53], metal)
      addBox(station, [0.07, 1.32, 0.07], [-1.08, 0.68, -0.53], metal)
      addBox(station, [0.07, 1.32, 0.07], [1.08, 0.68, 0.53], metal)
      addBox(station, [0.07, 1.32, 0.07], [1.08, 0.68, -0.53], metal)
      addBox(station, [2.2, 0.045, 0.05], [0, 1.26, -0.62], seam)

      addBox(station, [0.48, 1.1, 0.78], [0.86, 0.58, 0.1], white)
      addBox(station, [0.4, 0.025, 0.03], [0.86, 0.9, 0.51], seam)
      addBox(station, [0.4, 0.025, 0.03], [0.86, 0.62, 0.51], seam)
      addBox(station, [0.18, 0.02, 0.035], [0.86, 0.76, 0.53], metal)

      const monitor = new THREE.Group()
      monitor.position.set(0, 1.53, -0.32)
      station.add(monitor)
      addBox(monitor, [0.98, 0.58, 0.055], [0, 0.44, 0], screen)
      addBox(monitor, [1.08, 0.66, 0.035], [0, 0.44, -0.03], metal)
      addBox(monitor, [0.08, 0.26, 0.075], [0, 0.08, 0.04], metal)
      addBox(monitor, [0.36, 0.055, 0.23], [0, -0.08, 0.08], metal)

      addBox(station, [0.75, 0.04, 0.22], [-0.08, 1.6, 0.32], softWhite)
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 9; col += 1) {
          addBox(
            station,
            [0.04, 0.009, 0.026],
            [-0.38 + col * 0.077, 1.63, 0.26 + row * 0.04],
            seam,
          )
        }
      }
      addBox(station, [0.26, 0.011, 0.026], [-0.04, 1.64, 0.41], seam)

      const mouse = new THREE.Mesh(new THREE.SphereGeometry(0.08, 24, 12), softWhite)
      mouse.scale.set(1, 0.18, 1.38)
      mouse.position.set(0.58, 1.62, 0.31)
      mouse.castShadow = true
      mouse.receiveShadow = true
      station.add(mouse)

      const chair = new THREE.Group()
      chair.position.set(-0.08, 0, 1.03)
      station.add(chair)
      addBox(chair, [0.64, 0.14, 0.58], [0, 0.46, 0], white)
      addBox(chair, [0.64, 0.76, 0.12], [0, 0.86, 0.31], softWhite)
      addCylinder(chair, 0.045, 0.48, [0, 0.24, 0], metal, 24)
      addCylinder(chair, 0.13, 0.055, [0, 0.03, 0], metal, 24)

      for (let i = 0; i < 5; i += 1) {
        const angle = (i / 5) * Math.PI * 2
        const arm = addBox(chair, [0.34, 0.035, 0.05], [0, 0.07, 0], metal)
        arm.position.x = Math.cos(angle) * 0.16
        arm.position.z = Math.sin(angle) * 0.16
        arm.rotation.y = -angle

        const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.01, 8, 16), metal)
        wheel.position.set(Math.cos(angle) * 0.34, 0.035, Math.sin(angle) * 0.34)
        wheel.rotation.x = Math.PI / 2
        wheel.rotation.z = angle
        wheel.castShadow = true
        wheel.receiveShadow = true
        chair.add(wheel)
      }
    }

    for (let index = 0; index < workstationCount; index += 1) {
      const row = Math.floor(index / columns)
      const col = index % columns
      createWorkstation((col - 1) * columnGap, (row - (rows - 1) / 2) * rowGap)
    }

    const render = () => {
      renderer.render(scene, camera)
    }

    const resize = () => {
      const width = Math.max(1, mount.clientWidth)
      const height = Math.max(1, mount.clientHeight)
      const aspect = width / height
      camera.left = (-frustumSize * aspect) / 2
      camera.right = (frustumSize * aspect) / 2
      camera.top = frustumSize / 2
      camera.bottom = -frustumSize / 2
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
      render()
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(mount)
    resize()

    return () => {
      resizeObserver.disconnect()
      renderer.dispose()

      const geometries = new Set<THREE.BufferGeometry>()
      const materials = new Set<THREE.Material>()
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return
        geometries.add(object.geometry)
        const material = object.material
        if (Array.isArray(material)) {
          for (const item of material) materials.add(item)
        } else {
          materials.add(material)
        }
      })
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()

      renderer.domElement.remove()
    }
  }, [agentCount])

  return (
    <div
      ref={mountRef}
      data-testid="office-scene"
      className="relative min-h-0 flex-1 overflow-hidden bg-[#f6f6f3]"
    />
  )
}
