
import { doc } from 'lib0/dom.js'
import { Timestamp } from '../data/CommonTypes.js'
import { inspectEngine } from '../data/Engine.js'
import { Store, getLocalEngine } from '../data/Store.js'
import { log, contains, deepPrint } from '../utils/utils.js'

export const enableTimeMonitor = (interval, callback) => {
    setInterval(callback, interval)
}

export const logTimeCallback = () => {
    log(`Time callback at ${new Date()}`)
}

// export const generateRandomArrayPopulationCallback = (apps: Array<string>) => {
//     // Randomly populate and depopulate the apps array with app names every 5 seconds. 
//     // Choose from a list of app names such as "app1", "app2", "app3", "app4", "app5" etc.
//     // The array should contain between 0 and 5 app names at any given time.
//     // Make sure that any app name only appears once in the array.
//     // Do it
//     const appNames = ['app1', 'app2', 'app3', 'app4', 'app5']
//     // If the array is empty, add a random app name
//     // If the array is full, remove a random app name
//     // If the array is not empty and not full, randomly decide whether to add or remove an app name and only select an app name that is not already in the array
//     return () => {
//         if (apps.length === 0) {
//             apps.insert(0, [appNames[Math.floor(Math.random() * appNames.length)]])
//         } else if (apps.length === 5) {
//             apps.delete(Math.floor(Math.random() * 5))
//         } else {
//             if (Math.random() < 0.5) {
//                 const randomAppName = appNames[Math.floor(Math.random() * appNames.length)]
//                 if (!contains(apps, randomAppName)) {
//                     apps.insert(0, [randomAppName])
//                 }
//             } else {
//                 apps.delete(Math.floor(Math.random() * apps.length))
//             }
//         }
//     }
// }


// const generateRandomArrayModification = (apps: Array<object>) => {
//     apps.insert(0, [{ name: 'app1' }, { name: 'app2' }, { name: 'app3' }, { name: 'app4' }, { name: 'app5' }])
//     log(`Initialising apps array with app names`)
//     // Create a function that first removes any x letters from all app names and then 
//     // randomly puts a capital x behind the name of an app in the apps array 
//     // Do it
//     return () => {
//         apps.forEach((app: { name: string }, index: number) => {
//             app.name = app.name.replace('X', '')
//             if (Math.random() < 0.5) {
//                 app.name = app.name + 'X'
//             }
//         })
//         console.log(`Deep change to apps: ${JSON.stringify(apps.toArray())}`)
//     }
// }

// export const changeTest = (store:Store) => {
//     const localEngine = getLocalEngine(store)
//     if (localEngine && localEngine.lastBooted) {
//         localEngine.lastBooted = localEngine.lastBooted + 1 as Timestamp
//         log(`CHANGING ENGINE LASTBOOTED TO ${localEngine.lastBooted}`)
//         log(deepPrint(localEngine))
//     } else {
//         log(`CHANGETEST: Engine not yet available ********`)
//     }
// }

let runs = 0

export const generateHeartBeat = (storeHandle) => {
    runs++
    storeHandle.change(doc => {
        const lastRun = (new Date()).getTime() as Timestamp
        log(`UPDATING ENGINE LASTRUN TO ${lastRun}`)
        //log(`This is the doc to change: ${deepPrint(doc, 2)}`)
        const localEngine = getLocalEngine(doc)
        localEngine.lastRun = lastRun
        //inspectEngine(store, localEngine)
    })
} 