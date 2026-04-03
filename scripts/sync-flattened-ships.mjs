import fs from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const sourcePath = path.join(projectRoot, 'src/data/flattened_ships.json')
const outputPath = path.join(projectRoot, 'public/flattened_ships.json')

function ensureOutputDirectory() {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
}

function isOutputCurrent() {
  if (!fs.existsSync(outputPath)) {
    return false
  }

  const sourceStats = fs.statSync(sourcePath)
  const outputStats = fs.statSync(outputPath)

  return outputStats.mtimeMs >= sourceStats.mtimeMs
}

function main() {
  ensureOutputDirectory()

  if (isOutputCurrent()) {
    console.log('flattened_ships.json is already synced.')
    return
  }

  fs.copyFileSync(sourcePath, outputPath)
  console.log('Synced src/data/flattened_ships.json to public/flattened_ships.json.')
}

main()
