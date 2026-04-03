import fs from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const sourcePath = path.join(projectRoot, 'src/data/flattened_ships.json')
const outputDirectory = path.join(projectRoot, 'public/ship-hours')
const indexPath = path.join(outputDirectory, 'index.json')
const coordinateScale = 100000

function encodeCoordinate(value) {
  return Math.round(Number(value) * coordinateScale)
}

function encodeTimestamp(value) {
  return Math.round(Date.parse(`${value}Z`) / 1000)
}

function getHourFilename(hourKey) {
  return `${hourKey.replaceAll(':', '-')}.json`
}

function ensureFreshOutputDirectory() {
  fs.mkdirSync(outputDirectory, { recursive: true })
}

function isOutputCurrent() {
  if (!fs.existsSync(indexPath)) {
    return false
  }

  const sourceStats = fs.statSync(sourcePath)
  const indexStats = fs.statSync(indexPath)

  return indexStats.mtimeMs >= sourceStats.mtimeMs
}

function main() {
  ensureFreshOutputDirectory()

  if (isOutputCurrent()) {
    console.log('Ship hour data is already up to date.')
    return
  }

  const flattenedShips = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
  const shipIds = []
  const shipIdToIndex = new Map()
  const hours = Object.keys(flattenedShips).sort()
  let timelineStart = Infinity
  let timelineEnd = -Infinity

  for (const hourKey of hours) {
    const compactHour = []

    for (const [shipId, latitude, longitude, timestamp] of flattenedShips[hourKey]) {
      let shipIndex = shipIdToIndex.get(shipId)

      if (shipIndex === undefined) {
        shipIndex = shipIds.length
        shipIdToIndex.set(shipId, shipIndex)
        shipIds.push(shipId)
      }

      const encodedTimestamp = encodeTimestamp(timestamp)

      if (!Number.isFinite(encodedTimestamp)) {
        continue
      }

      timelineStart = Math.min(timelineStart, encodedTimestamp * 1000)
      timelineEnd = Math.max(timelineEnd, encodedTimestamp * 1000)

      compactHour.push([
        shipIndex,
        encodeCoordinate(longitude),
        encodeCoordinate(latitude),
        encodedTimestamp,
      ])
    }

    const outputPath = path.join(outputDirectory, getHourFilename(hourKey))
    fs.writeFileSync(outputPath, JSON.stringify(compactHour))
  }

  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      coordinateScale,
      hours,
      shipIds,
      timelineStart,
      timelineEnd,
    }),
  )

  console.log(`Prepared ${hours.length} hourly ship files in ${path.relative(projectRoot, outputDirectory)}.`)
}

main()
