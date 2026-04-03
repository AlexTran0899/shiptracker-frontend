import { startTransition, useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'

import 'mapbox-gl/dist/mapbox-gl.css'

import './App.css'

const LONGITUDE_INDEX = 0
const LATITUDE_INDEX = 1
const TIME_INDEX = 2
const POINT_SIZE = 3
const MILLIS_PER_SECOND = 1000
const DEFAULT_COORDINATE_SCALE = 100000
const playbackDurationMs = 6000
const sliderStep = 30 * 60 * 1000
const trailWindowMs = 6 * 60 * 60 * 1000
const stationaryDotCutoffMs = 2 * 60 * 60 * 1000
const stationaryTrailCutoffMs = 48 * 60 * 60 * 1000
const playbackLookaheadHours = 2
const minRepresentativeTileZoom = 9
const maxRepresentativeTileZoom = 14
const geohashBase32 = '0123456789bcdefghjkmnpqrstuvwxyz'
const shipApiUrl = import.meta.env.VITE_SHIP_API_URL ?? 'https://xv5e6c3xhhpmod3csftedqnpem0aowjo.lambda-url.us-east-2.on.aws'
const shipApiRetryDelayMs = 2000

function delay(durationMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs)
  })
}

async function fetchJsonWithRetry(url, options) {
  let response

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      response = await fetch(url, options)

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`)
      }

      return await response.json()
    } catch (error) {
      if (attempt === 2) {
        throw error
      }

      await delay(shipApiRetryDelayMs)
    }
  }

  throw new Error('Request failed after retries')
}

function getShipColor(shipId) {
  let hash = 0

  for (const character of shipId) {
    hash = (hash * 31 + character.charCodeAt(0)) % 360
  }

  return `hsl(${hash} 78% 56%)`
}

function parseHourKey(hourKey) {
  return Date.parse(`${hourKey}Z`)
}

function getHourKeyFromTime(timestamp) {
  const hourDate = new Date(timestamp)
  hourDate.setUTCMinutes(0, 0, 0)

  return hourDate.toISOString().slice(0, 19)
}

function decodeCoordinate(value, coordinateScale) {
  return value / coordinateScale
}

function decodeTimestamp(value) {
  return value * MILLIS_PER_SECOND
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180
}

function getDistanceMiles(startLatitude, startLongitude, endLatitude, endLongitude) {
  const earthRadiusMiles = 3958.7613
  const latitudeDelta = degreesToRadians(endLatitude - startLatitude)
  const longitudeDelta = degreesToRadians(endLongitude - startLongitude)
  const startLatitudeRadians = degreesToRadians(startLatitude)
  const endLatitudeRadians = degreesToRadians(endLatitude)
  const haversineValue =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitudeRadians) *
      Math.cos(endLatitudeRadians) *
      Math.sin(longitudeDelta / 2) ** 2

  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(haversineValue))
}

function normalizeLongitude(longitude) {
  return ((longitude + 180) % 360 + 360) % 360 - 180
}

function isLongitudeWithinBounds(longitude, west, east) {
  if (west <= east) {
    return longitude >= west && longitude <= east
  }

  return longitude >= west || longitude <= east
}

function isCoordinateWithinBounds(longitude, latitude, bounds) {
  return (
    latitude >= bounds.south &&
    latitude <= bounds.north &&
    isLongitudeWithinBounds(normalizeLongitude(longitude), bounds.west, bounds.east)
  )
}

function getViewportMetrics(bounds) {
  const centerLatitude = (bounds.north + bounds.south) / 2
  const widthMiles = getDistanceMiles(centerLatitude, bounds.west, centerLatitude, bounds.east)
  const heightMiles = getDistanceMiles(bounds.south, bounds.west, bounds.north, bounds.west)

  return {
    widthMiles,
    heightMiles,
    isPlaybackAreaValid: true,
  }
}

function getBoundsCenter(bounds) {
  const centerLatitude = (bounds.north + bounds.south) / 2
  const centerLongitude =
    bounds.west <= bounds.east
      ? (bounds.west + bounds.east) / 2
      : normalizeLongitude((bounds.west + bounds.east + 360) / 2)

  return {
    longitude: centerLongitude,
    latitude: centerLatitude,
  }
}

function getNormalizedBounds(map) {
  const bounds = map.getBounds()

  return {
    west: normalizeLongitude(bounds.getWest()),
    south: bounds.getSouth(),
    east: normalizeLongitude(bounds.getEast()),
    north: bounds.getNorth(),
  }
}

function encodeGeohash(latitude, longitude, precision = 3) {
  let latitudeRange = [-90, 90]
  let longitudeRange = [-180, 180]
  let hash = ''
  let bit = 0
  let characterBits = 0
  let isEvenBit = true

  while (hash.length < precision) {
    if (isEvenBit) {
      const midpoint = (longitudeRange[0] + longitudeRange[1]) / 2

      if (longitude >= midpoint) {
        characterBits = (characterBits << 1) | 1
        longitudeRange[0] = midpoint
      } else {
        characterBits <<= 1
        longitudeRange[1] = midpoint
      }
    } else {
      const midpoint = (latitudeRange[0] + latitudeRange[1]) / 2

      if (latitude >= midpoint) {
        characterBits = (characterBits << 1) | 1
        latitudeRange[0] = midpoint
      } else {
        characterBits <<= 1
        latitudeRange[1] = midpoint
      }
    }

    isEvenBit = !isEvenBit
    bit += 1

    if (bit === 5) {
      hash += geohashBase32[characterBits]
      bit = 0
      characterBits = 0
    }
  }

  return hash
}

function parseApiTimestamp(timestamp) {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return timestamp < 1_000_000_000_000 ? timestamp * MILLIS_PER_SECOND : timestamp
  }

  if (typeof timestamp === 'string') {
    const numericTimestamp = Number(timestamp)

    if (Number.isFinite(numericTimestamp)) {
      return numericTimestamp < 1_000_000_000_000
        ? numericTimestamp * MILLIS_PER_SECOND
        : numericTimestamp
    }

    const normalizedTimestamp = timestamp
      .trim()
      .replace(
        /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3})\d+(Z)?$/,
        '$1.$2$3',
      )
    const utcTimestamp = normalizedTimestamp.endsWith('Z')
      ? normalizedTimestamp
      : `${normalizedTimestamp}Z`
    const parsedTimestamp = Date.parse(utcTimestamp)

    if (Number.isFinite(parsedTimestamp)) {
      return parsedTimestamp
    }
  }

  return NaN
}

function getPointOffset(pointIndex) {
  return pointIndex * POINT_SIZE
}

function getPointCount(ship) {
  return ship.route.length / POINT_SIZE
}

function getPointLongitude(ship, pointIndex, coordinateScale) {
  return decodeCoordinate(ship.route[getPointOffset(pointIndex) + LONGITUDE_INDEX], coordinateScale)
}

function getPointLatitude(ship, pointIndex, coordinateScale) {
  return decodeCoordinate(ship.route[getPointOffset(pointIndex) + LATITUDE_INDEX], coordinateScale)
}

function getPointTime(ship, pointIndex) {
  return decodeTimestamp(ship.route[getPointOffset(pointIndex) + TIME_INDEX])
}

function getPointCoordinates(ship, pointIndex, coordinateScale) {
  return [
    getPointLongitude(ship, pointIndex, coordinateScale),
    getPointLatitude(ship, pointIndex, coordinateScale),
  ]
}

function buildFleet(requiredHours, hourCache, coordinateScale, viewportBounds) {
  const shipsById = new Map()
  const visibleShipIds = new Set()

  for (const hourKey of requiredHours) {
    const hourEntries = hourCache.get(hourKey)

    if (!hourEntries) {
      continue
    }

    for (const [idIndex, longitude, latitude, timestamp] of hourEntries) {
      const decodedLongitude = decodeCoordinate(longitude, coordinateScale)
      const decodedLatitude = decodeCoordinate(latitude, coordinateScale)

      if (
        !visibleShipIds.has(idIndex) &&
        isCoordinateWithinBounds(decodedLongitude, decodedLatitude, viewportBounds)
      ) {
        visibleShipIds.add(idIndex)
      }

      let ship = shipsById.get(idIndex)

      if (!ship) {
        ship = {
          idIndex,
          route: [],
        }
        shipsById.set(idIndex, ship)
      }

      ship.route.push(longitude, latitude, timestamp)
    }
  }

  return [...shipsById.values()].filter(
    (ship) => ship.route.length >= POINT_SIZE && visibleShipIds.has(ship.idIndex),
  )
}

function clampLatitude(latitude) {
  return Math.max(Math.min(latitude, 85.05112878), -85.05112878)
}

function getRepresentativeTileZoom(mapZoom = 0) {
  const zoomOffset = Math.floor(mapZoom) + 6

  return Math.min(maxRepresentativeTileZoom, Math.max(minRepresentativeTileZoom, zoomOffset))
}

function getEarthTileKey([longitude, latitude], zoom) {
  const scale = 2 ** zoom
  const wrappedLongitude = ((longitude + 180) % 360 + 360) % 360
  const normalizedLatitude = clampLatitude(latitude)
  const latitudeRadians = (normalizedLatitude * Math.PI) / 180
  const tileX = Math.min(scale - 1, Math.floor((wrappedLongitude / 360) * scale))
  const mercatorY =
    (1 -
      Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) /
    2
  const tileY = Math.min(scale - 1, Math.max(0, Math.floor(mercatorY * scale)))

  return `${zoom}:${tileX}:${tileY}`
}

function interpolatePosition(startPoint, endPoint, targetTime) {
  const duration = endPoint[TIME_INDEX] - startPoint[TIME_INDEX]

  if (duration <= 0) {
    return [endPoint[LONGITUDE_INDEX], endPoint[LATITUDE_INDEX]]
  }

  const progress = (targetTime - startPoint[TIME_INDEX]) / duration

  return [
    startPoint[LONGITUDE_INDEX] + (endPoint[LONGITUDE_INDEX] - startPoint[LONGITUDE_INDEX]) * progress,
    startPoint[LATITUDE_INDEX] + (endPoint[LATITUDE_INDEX] - startPoint[LATITUDE_INDEX]) * progress,
  ]
}

function getPositionAtTime(ship, targetTime, coordinateScale) {
  const lastPointIndex = getPointCount(ship) - 1

  if (targetTime <= getPointTime(ship, 0)) {
    return getPointCoordinates(ship, 0, coordinateScale)
  }

  if (targetTime >= getPointTime(ship, lastPointIndex)) {
    return getPointCoordinates(ship, lastPointIndex, coordinateScale)
  }

  let segmentIndex = -1

  for (let index = 0; index <= lastPointIndex; index += 1) {
    if (getPointTime(ship, index) >= targetTime) {
      segmentIndex = index
      break
    }
  }

  if (segmentIndex <= 0) {
    return getPointCoordinates(ship, 0, coordinateScale)
  }

  return interpolatePosition(
    [
      getPointLongitude(ship, segmentIndex - 1, coordinateScale),
      getPointLatitude(ship, segmentIndex - 1, coordinateScale),
      getPointTime(ship, segmentIndex - 1),
    ],
    [
      getPointLongitude(ship, segmentIndex, coordinateScale),
      getPointLatitude(ship, segmentIndex, coordinateScale),
      getPointTime(ship, segmentIndex),
    ],
    targetTime,
  )
}

function areCoordinatesEqual(firstCoordinates, secondCoordinates) {
  return (
    firstCoordinates[0] === secondCoordinates[0] &&
    firstCoordinates[1] === secondCoordinates[1]
  )
}

function getLastMovementTime(ship, targetTime, coordinateScale) {
  const currentPosition = getPositionAtTime(ship, targetTime, coordinateScale)
  let lastMovementTime = getPointTime(ship, 0)
  let lastObservedPosition = getPointCoordinates(ship, 0, coordinateScale)

  for (let index = 1; index < getPointCount(ship); index += 1) {
    const pointTime = getPointTime(ship, index)

    if (pointTime > targetTime) {
      break
    }

    const pointCoordinates = getPointCoordinates(ship, index, coordinateScale)

    if (!areCoordinatesEqual(lastObservedPosition, pointCoordinates)) {
      lastMovementTime = pointTime
      lastObservedPosition = pointCoordinates
    }
  }

  if (!areCoordinatesEqual(lastObservedPosition, currentPosition)) {
    lastMovementTime = targetTime
  }

  return lastMovementTime
}

function getRepresentativeFleet(targetTime, mapZoom, fleet, coordinateScale) {
  const representativesByTile = new Map()
  const tileZoom = getRepresentativeTileZoom(mapZoom)

  for (const ship of fleet) {
    if (targetTime < getPointTime(ship, 0)) {
      continue
    }

    const currentPosition = getPositionAtTime(ship, targetTime, coordinateScale)
    const tileKey = getEarthTileKey(currentPosition, tileZoom)
    const existingRepresentative = representativesByTile.get(tileKey)

    if (existingRepresentative) {
      existingRepresentative.count += 1
      continue
    }

    representativesByTile.set(tileKey, {
      ship,
      currentPosition,
      count: 1,
    })
  }

  return [...representativesByTile.values()]
}

function App() {
  const mapRef = useRef()
  const mapContainerRef = useRef()
  const animationFrameRef = useRef()
  const updateShipRef = useRef()
  const lastFrameTimeRef = useRef(null)
  const fleetRef = useRef([])
  const hourCacheRef = useRef(new Map())
  const loadedHourSignatureRef = useRef('')
  const coordinateScaleRef = useRef(DEFAULT_COORDINATE_SCALE)
  const shipIdsRef = useRef([])
  const shipColorsRef = useRef([])
  const timelineBoundsRef = useRef(null)
  const loadedDataGeohashRef = useRef('')
  const playbackStartRef = useRef(0)
  const isPlayingRef = useRef(false)
  const currentTimeRef = useRef(0)
  const [isPlayPending, setIsPlayPending] = useState(false)
  const [timelineBounds, setTimelineBounds] = useState(null)
  const [availableHours, setAvailableHours] = useState([])
  const [playbackStart, setPlaybackStart] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackBounds, setPlaybackBounds] = useState(null)
  const [fleetVersion, setFleetVersion] = useState(0)
  const [isDataLoading, setIsDataLoading] = useState(false)
  const [isFleetReady, setIsFleetReady] = useState(false)
  const [viewportState, setViewportState] = useState({
    bounds: null,
    widthMiles: Infinity,
    heightMiles: Infinity,
    isPlaybackAreaValid: false,
  })

  const activeFleetBounds = playbackBounds

  useEffect(() => {
    playbackStartRef.current = playbackStart
  }, [playbackStart])

  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  useEffect(() => {
    currentTimeRef.current = currentTime
  }, [currentTime])

  useEffect(() => {
    timelineBoundsRef.current = timelineBounds
  }, [timelineBounds])

  useEffect(() => {
    if (viewportState.isPlaybackAreaValid || playbackBounds) {
      return
    }

    loadedDataGeohashRef.current = ''
    loadedHourSignatureRef.current = ''
    fleetRef.current = []
    hourCacheRef.current = new Map()
    shipIdsRef.current = []
    shipColorsRef.current = []
    startTransition(() => {
      setAvailableHours([])
      setIsFleetReady(false)
      setIsPlayPending(false)
      setTimelineBounds(null)
      setPlaybackStart(0)
      setCurrentTime(0)
      setIsDataLoading(false)
      setFleetVersion((value) => value + 1)
    })
  }, [playbackBounds, viewportState.isPlaybackAreaValid])

  useEffect(() => {
    if (!activeFleetBounds || !isPlayPending || !viewportState.isPlaybackAreaValid) {
      return
    }

    const viewportCenter = getBoundsCenter(activeFleetBounds)
    const viewportGeohash = encodeGeohash(viewportCenter.latitude, viewportCenter.longitude, 3)

    if (loadedDataGeohashRef.current === viewportGeohash) {
      return
    }

    let isCancelled = false

    const loadViewportDataset = async () => {
      setIsDataLoading(true)
      setIsFleetReady(false)
      loadedHourSignatureRef.current = ''
      hourCacheRef.current = new Map()
      setAvailableHours([])
      setTimelineBounds(null)

      const manifestEntries = await fetchJsonWithRetry(shipApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          geohash: viewportGeohash,
        }),
      })
      const rawShipData = Array.isArray(manifestEntries)
        ? (
            await Promise.all(
              manifestEntries
                .filter((entry) => entry?.url)
                .map((entry) => fetchJsonWithRetry(entry.url)),
            )
          ).flat()
        : []
      const shipIds = []
      const shipIdToIndex = new Map()
      const hourCache = new Map()
      let timelineStart = Infinity
      let timelineEnd = -Infinity

      const normalizedEntries = Array.isArray(rawShipData)
        ? rawShipData
            .map((entry) => {
              if (!Array.isArray(entry) || entry.length < 4) {
                return null
              }

              const [shipId, latitude, longitude, timestamp] = entry
              const numericLongitude = Number(longitude)
              const numericLatitude = Number(latitude)
              const timestampMs = parseApiTimestamp(timestamp)

              if (
                !shipId ||
                !Number.isFinite(numericLongitude) ||
                !Number.isFinite(numericLatitude) ||
                !Number.isFinite(timestampMs)
              ) {
                return null
              }

              return {
                shipId,
                latitude: numericLatitude,
                longitude: numericLongitude,
                timestampMs,
              }
            })
            .filter(Boolean)
            .sort((firstEntry, secondEntry) => firstEntry.timestampMs - secondEntry.timestampMs)
        : []

      for (const entry of normalizedEntries) {
        if (!isCoordinateWithinBounds(entry.longitude, entry.latitude, activeFleetBounds)) {
          continue
        }

        let shipIndex = shipIdToIndex.get(entry.shipId)

        if (shipIndex === undefined) {
          shipIndex = shipIds.length
          shipIdToIndex.set(entry.shipId, shipIndex)
          shipIds.push(entry.shipId)
        }

        const encodedTimestamp = Math.round(entry.timestampMs / MILLIS_PER_SECOND)
        const hourKey = getHourKeyFromTime(entry.timestampMs)
        const compactHour = hourCache.get(hourKey) ?? []

        timelineStart = Math.min(timelineStart, entry.timestampMs)
        timelineEnd = Math.max(timelineEnd, entry.timestampMs)

        compactHour.push([
          shipIndex,
          Math.round(entry.longitude * DEFAULT_COORDINATE_SCALE),
          Math.round(entry.latitude * DEFAULT_COORDINATE_SCALE),
          encodedTimestamp,
        ])
        hourCache.set(hourKey, compactHour)
      }

      const hours = [...hourCache.keys()].sort()

      if (isCancelled) {
        return
      }

      loadedDataGeohashRef.current = viewportGeohash
      loadedHourSignatureRef.current = ''
      coordinateScaleRef.current = DEFAULT_COORDINATE_SCALE
      shipIdsRef.current = shipIds
      shipColorsRef.current = shipIds.map((shipId) => getShipColor(shipId))
      hourCacheRef.current = hourCache
      setAvailableHours(hours)

      if (Number.isFinite(timelineStart) && Number.isFinite(timelineEnd)) {
        setTimelineBounds({
          start: timelineStart,
          end: timelineEnd,
        })
        setPlaybackStart(timelineStart)
        setCurrentTime(timelineStart)
      } else {
        setTimelineBounds(null)
        setPlaybackStart(0)
        setCurrentTime(0)
        setIsFleetReady(false)
        setIsPlayPending(false)
      }

      setIsDataLoading(false)
      setFleetVersion((value) => value + 1)
    }

    loadViewportDataset().catch((error) => {
      console.error('Failed to load ship dataset for viewport.', error)

      if (!isCancelled) {
        setIsFleetReady(false)
        setIsDataLoading(false)
        setIsPlayPending(false)
      }
    })

    return () => {
      isCancelled = true
    }
  }, [activeFleetBounds, isPlayPending, viewportState.isPlaybackAreaValid])

  useEffect(() => {
    if (!availableHours.length || !timelineBounds || !activeFleetBounds) {
      return
    }

    if (!viewportState.isPlaybackAreaValid && !playbackBounds) {
      fleetRef.current = []
      loadedHourSignatureRef.current = ''
      startTransition(() => {
        setIsFleetReady(false)
        setFleetVersion((value) => value + 1)
        setIsDataLoading(false)
      })
      return
    }

    const routeEndTime = Math.min(
      currentTime + playbackLookaheadHours * 60 * 60 * 1000,
      timelineBounds.end,
    )
    const requiredHourKeys = availableHours.filter((hourKey) => {
      const hourTimestamp = parseHourKey(hourKey)
      return hourTimestamp >= parseHourKey(getHourKeyFromTime(playbackStart)) &&
        hourTimestamp <= parseHourKey(getHourKeyFromTime(routeEndTime))
    })
    const requiredSignature = [
      requiredHourKeys.join('|'),
      activeFleetBounds.west,
      activeFleetBounds.south,
      activeFleetBounds.east,
      activeFleetBounds.north,
    ].join('::')

    if (requiredSignature === loadedHourSignatureRef.current) {
      return
    }

    let isCancelled = false

    const loadRequiredHours = async () => {
      setIsDataLoading(true)
      const nextFleet = buildFleet(
        requiredHourKeys,
        hourCacheRef.current,
        coordinateScaleRef.current,
        activeFleetBounds,
      )

      if (isCancelled) {
        return
      }

      fleetRef.current = nextFleet
      loadedHourSignatureRef.current = requiredSignature
      setIsFleetReady(true)
      setFleetVersion((value) => value + 1)
      setIsDataLoading(false)
    }

    loadRequiredHours().catch((error) => {
      console.error('Failed to build ship playback data.', error)

      if (!isCancelled) {
        setIsFleetReady(false)
        setIsDataLoading(false)
      }
    })

    return () => {
      isCancelled = true
    }
  }, [
    activeFleetBounds,
    availableHours,
    currentTime,
    isPlayPending,
    playbackBounds,
    playbackStart,
    isPlaying,
    timelineBounds,
    viewportState.isPlaybackAreaValid,
  ])

  useEffect(() => {
    if (!isPlayPending || isDataLoading || !isFleetReady) {
      return
    }

    if (!timelineBounds) {
      return
    }

    const frameId = requestAnimationFrame(() => {
      if (currentTime >= timelineBounds.end) {
        setCurrentTime(playbackStart)
      }

      setIsPlaying(true)
      setIsPlayPending(false)
    })

    return () => {
      cancelAnimationFrame(frameId)
    }
  }, [currentTime, isDataLoading, isFleetReady, isPlayPending, playbackStart, timelineBounds])

  useEffect(() => {
    if (isPlaying && !viewportState.isPlaybackAreaValid) {
      startTransition(() => {
        setIsPlaying(false)
      })
    }
  }, [isPlaying, viewportState.isPlaybackAreaValid])

  useEffect(() => {
    mapboxgl.accessToken = 'pk.eyJ1IjoiYWxleHRyYW4wODk5IiwiYSI6ImNtbjhzdmU4djAxYngycm9oMXp0cGx4dmQifQ.rd5U0VETBkIjHkK29pd5dw'
    mapRef.current = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [-79.5, 8.9],
      zoom: 2.35,
      projection: 'globe',
    })

    mapRef.current.on('style.load', () => {
      mapRef.current.setFog({
        color: 'rgb(10, 12, 20)',
        'high-color': 'rgb(28, 40, 78)',
        'horizon-blend': 1,
        'space-color': 'rgb(2, 4, 10)',
        'star-intensity': 1,
      })
    })

    mapRef.current.on('load', () => {
      const trailGeoJson = {
        type: 'FeatureCollection',
        features: [],
      }

      const shipGeoJson = {
        type: 'FeatureCollection',
        features: [],
      }

      mapRef.current.addSource('ship-trail', {
        type: 'geojson',
        data: trailGeoJson,
        lineMetrics: true,
      })

      mapRef.current.addSource('ship-point', {
        type: 'geojson',
        data: shipGeoJson,
      })

      mapRef.current.addLayer({
        id: 'ship-trail-glow',
        type: 'line',
        source: 'ship-trail',
        paint: {
          'line-gradient': [
            'interpolate',
            ['linear'],
            ['line-progress'],
            0, 'rgba(103, 232, 249, 0)',
            0.65, 'rgba(103, 232, 249, 0.08)',
            1, 'rgba(103, 232, 249, 0.3)',
          ],
          'line-width': 8,
          'line-blur': 1.2,
        },
      })

      mapRef.current.addLayer({
        id: 'ship-trail-line',
        type: 'line',
        source: 'ship-trail',
        paint: {
          'line-gradient': [
            'interpolate',
            ['linear'],
            ['line-progress'],
            0, 'rgba(165, 243, 252, 0)',
            0.5, 'rgba(165, 243, 252, 0.18)',
            1, 'rgba(165, 243, 252, 0.95)',
          ],
          'line-width': 2.5,
        },
      })

      mapRef.current.addLayer({
        id: 'ship-point',
        type: 'circle',
        source: 'ship-point',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            1,
            1.2,
            4,
            1.8,
            7,
            2.4,
          ],
          'circle-color': '#f8fafc',
          'circle-stroke-width': 0.8,
          'circle-stroke-color': '#22d3ee',
        },
      })

      const updateViewportState = () => {
        const nextBounds = getNormalizedBounds(mapRef.current)
        const metrics = getViewportMetrics(nextBounds)

        setViewportState({
          bounds: nextBounds,
          ...metrics,
        })
      }

      const updateShipPosition = (targetTime) => {
        const representativeFleet = getRepresentativeFleet(
          targetTime,
          mapRef.current.getZoom(),
          fleetRef.current,
          coordinateScaleRef.current,
        )
        const visibleRepresentatives = representativeFleet.filter(({ ship }) => {
          const lastMovementTime = getLastMovementTime(ship, targetTime, coordinateScaleRef.current)

          return targetTime - lastMovementTime < stationaryDotCutoffMs
        })

        trailGeoJson.features = visibleRepresentatives.map(({ ship, currentPosition, count }) => {
            const lastMovementTime = getLastMovementTime(ship, targetTime, coordinateScaleRef.current)

            if (targetTime - lastMovementTime >= stationaryTrailCutoffMs) {
              return null
            }

            const trailStartTime = Math.max(
              playbackStartRef.current,
              targetTime - trailWindowMs,
              getPointTime(ship, 0),
            )
            const trailStartPosition = getPositionAtTime(ship, trailStartTime, coordinateScaleRef.current)
            const visibleTrail = []

            for (let index = 0; index < getPointCount(ship); index += 1) {
              const pointTime = getPointTime(ship, index)

              if (pointTime > trailStartTime && pointTime < targetTime) {
                visibleTrail.push(getPointCoordinates(ship, index, coordinateScaleRef.current))
              }
            }

            return {
              type: 'Feature',
              properties: {
                id: shipIdsRef.current[ship.idIndex],
                color: shipColorsRef.current[ship.idIndex],
                count,
              },
              geometry: {
                type: 'LineString',
                coordinates: [trailStartPosition, ...visibleTrail, currentPosition],
              },
            }
          })
          .filter(Boolean)

        shipGeoJson.features = visibleRepresentatives.map(({ ship, currentPosition, count }) => {
            return {
              type: 'Feature',
              properties: {
                id: shipIdsRef.current[ship.idIndex],
                color: shipColorsRef.current[ship.idIndex],
                count,
              },
              geometry: {
                type: 'Point',
                coordinates: currentPosition,
              },
            }
          })

        mapRef.current.getSource('ship-trail')?.setData(trailGeoJson)
        mapRef.current.getSource('ship-point')?.setData(shipGeoJson)
      }

      updateShipRef.current = updateShipPosition
      updateViewportState()
      if (currentTimeRef.current > 0) {
        updateShipPosition(currentTimeRef.current)
      }
      mapRef.current.on('moveend', () => {
        updateViewportState()
        updateShipRef.current?.(currentTimeRef.current)
      })

      const animateShip = (frameTime) => {
        if (isPlayingRef.current && timelineBoundsRef.current) {
          if (lastFrameTimeRef.current === null) {
            lastFrameTimeRef.current = frameTime
          }

          const elapsed = frameTime - lastFrameTimeRef.current
          lastFrameTimeRef.current = frameTime
          const playbackRate = Math.max(
            (timelineBoundsRef.current.end - playbackStartRef.current) / playbackDurationMs,
            1,
          )
          const nextTime = Math.min(
            currentTimeRef.current + elapsed * playbackRate,
            timelineBoundsRef.current.end,
          )

          setCurrentTime(nextTime)

          if (nextTime >= timelineBoundsRef.current.end) {
            setIsPlaying(false)
          }
        } else {
          lastFrameTimeRef.current = frameTime
        }

        animationFrameRef.current = requestAnimationFrame(animateShip)
      }

      animationFrameRef.current = requestAnimationFrame(animateShip)
    })

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }

      mapRef.current.remove()
    }
  }, [])

  useEffect(() => {
    updateShipRef.current?.(currentTime)
  }, [currentTime, fleetVersion])

  const handleCurrentTimeChange = (event) => {
    setPlaybackBounds(null)
    loadedHourSignatureRef.current = ''
    setIsPlaying(false)
    setCurrentTime(Number(event.target.value))
  }

  const togglePlayback = () => {
    if (!viewportState.isPlaybackAreaValid) {
      return
    }

    if (isPlaying) {
      setIsPlaying(false)
      return
    }

    const nextPlaybackBounds = mapRef.current
      ? getNormalizedBounds(mapRef.current)
      : viewportState.bounds

    loadedDataGeohashRef.current = ''
    loadedHourSignatureRef.current = ''
    fleetRef.current = []
    setIsPlaying(false)
    setIsFleetReady(false)
    setIsPlayPending(true)
    setPlaybackBounds(nextPlaybackBounds)
    setFleetVersion((value) => value + 1)
  }

  const timelineEnd = timelineBounds?.end ?? 0
  const isPlaybackStarting = isPlayPending || (isDataLoading && !isPlaying)
  const currentTimeLabel = timelineBounds
    ? `${new Date(currentTime).toISOString().replace('T', ' ').slice(0, 16)} UTC`
    : '--'

  return (
    <div className='app-shell'>
      <div id='map-container' ref={mapContainerRef} />
      <section className='timeline-panel'>
        <p className='timeline-panel__clock'>{currentTimeLabel}</p>
        <div className='timeline-panel__controls'>
          <input
            className='timeline-panel__slider'
            id='current-time'
            type='range'
            min={playbackStart}
            max={timelineEnd}
            step={sliderStep}
            value={Math.min(currentTime, timelineEnd)}
            onChange={handleCurrentTimeChange}
            disabled={!timelineBounds || !viewportState.isPlaybackAreaValid}
          />
          <button
            className='timeline-panel__button'
            type='button'
            onClick={togglePlayback}
            disabled={isPlaybackStarting || !viewportState.isPlaybackAreaValid}
            aria-label={
              isPlaybackStarting
                ? 'Starting playback'
                : isPlaying
                  ? 'Pause playback'
                  : 'Play playback'
            }
          >
            {isPlaybackStarting ? (
              <span className='timeline-panel__spinner' aria-hidden='true' />
            ) : isPlaying ? (
              'Pause'
            ) : (
              'Play'
            )}
          </button>
        </div>
      </section>
    </div>
  )
}

export default App
