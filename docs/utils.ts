import util from 'util';
import { $, chalk, fs, os, question } from 'zx';
import { IPAddress, PortNumber } from '../data/CommonTypes.js';
import net from 'net';


// Dummy key
export const dummyKey = "_dummy"

export const getKeys = (obj) => {
  return Object.keys(obj).filter(key => !(key === `${dummyKey}`))
}

// Generate a random port number between 49152-65535
export const randomPort = ():PortNumber => {
  return Math.floor(Math.random() * 16383) + 49152 as PortNumber
}
// Write a function that reads a .env file and extracts the value of a variable from it
// The function should take the path to the .env file and the name of the variable as input
// It should return the value of the variable
// If the variable is not found, it should return null
export const readEnvVariable = async (path: string, variable: string): Promise<string | null> => {
  try {
    const envContent = (await $`cat ${path}`).stdout
    const values = envContent.match(new RegExp(`^${variable}=(.*)`, 'm'))
    log(`Values: ${deepPrint(values)}`)
    if (values && values.length >= 1) {
      const value = values[1]
      return value
    } else {
      return null
    }
  } catch (e) {
    return null
  }
}

// Write a function that adds or updates a variable to a .env file
// The function should take the path to the .env file, the name of the variable and its value as input
// If the variable is already present in the .env file, it should update its value
// If the variable is not present in the .env file, it should add it
export const addOrUpdateEnvVariable = async (path: string, variable: string, value: string): Promise<void> => {
  try {
    const envContent = (await $`cat ${path}`).stdout
    const values = envContent.match(new RegExp(`^${variable}=(.*)`, 'm'))
    if (values && values.length >= 1) {
      // Update the value of the variable
      await $`sed -i 's|^${variable}=.*|${variable}=${value}|' ${path}`
    } else {
      // Add the variable to the .env file
      await $`echo "${variable}=${value}" >> ${path}`
    }
    log(`Added or updated variable ${variable} in .env file ${path}`)
  } catch (e) {
    // Add the variable to the .env file
    log(`Error adding or updating variable ${variable} in .env file ${path}`)
    log(`error: ${e}`)
    //await $`echo "${variable}=${value}" >> ${path}`
  }
}



// Read verbosityLevel from the environmnet
const verbosity = process.env.VERBOSITY || ""
export let verbosityLevel = parseInt(verbosity) || 0

//export const log = console.log.bind(console);
export const log = (msg:string, level?:number):void => {
  if (!level) {
    // Set the default log level to 2
    level = 2
  }
  if (verbosityLevel >= level) {
    console.log(chalk.gray(msg))
  }
}

export const error = (msg:string):void => {
  console.log(chalk.red(msg))
  console.error(chalk.red(msg))
}

export const setVerbosity = (level:number):void => {
  verbosityLevel = level
}

export const isEngineOnline = (hostname: string, port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = 2000; // 2 seconds
    socket.setTimeout(timeout);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, hostname);
  });
};

// // Execute promises sequentially
// export const sequential = (promises) => {
//   return promises.reduce((promise, func) => {
//     return promise.then(func)
//   }, Promise.resolve())
// }

// export const executePromisesSequentially = async (promises) => {
//     for (let promise of promises) {
//       await promise
//     }
// }






// Write a function that uses zx to test if a path exists
// export const dirExists = async (path: string) => {
//     try {
//         await $`test -d ${path}`
//         return true
//     } catch (e) {
//         return false
//     }
// }

// export const dirExists = async (path: string) => {
//   return await $`test -d ${path}`.then(() => true).catch(() => false)
// }

// export const fileExists = async (path: string) => {
//   try {
//       await $`test -f ${path}`
//       return true
//   } catch (e) {
//       return false
//   }
// }

// export const fileExists = async (path: string) => {
//   return await $`test -f ${path}`.then(() => true).catch(() => false)
// }

export const fileExists = (path: string):boolean => {
  return fs.existsSync(path)
}

// Check if the root folder contains the folder yjs-db  If so, set firstBoot to false, otherwise set it to true
// This is a way to check if the engine has been booted before
// export const firstBoot: boolean = fs.existsSync('../yjs-db') ? false : true 
// export const firstBoot: boolean = !(await fileExists('./yjs-db'))
// log(`First boot: ${firstBoot}`)




// Write a function that checks if a given yarray contains a specific value
// Use the Y.Array API of the Yjs library (which does not have a built-in method for this)
// Do it
export const contains = (yarray, value) => {
    let found = false
    yarray.forEach((item) => {
      if (item === value) {
        found = true
      }
    })
    return found
  }

export const deepPrint = (obj, depth:(number | null)=null) => {
    return util.inspect(obj, {showHidden: false, depth: depth, colors: true})
    // Alternative: return JSON.stringify(obj, null, 2)
    // Alternative: return console.dir(obj, {depth: null, colors: true})
}


// Write a function that tests if a string is a valid IP4 address
export const isIP4 = (str: string): boolean => {
  const ip4Regex = /^(\d{1,3}\.){3}\d{1,3}$/
  return ip4Regex.test(str)
}

export const isNetmask = isIP4

// See https://stackoverflow.com/questions/503052/how-to-check-if-ip-is-in-one-of-these-subnets


// const ip2long = (ip) => {
//   var components;
//   if(components = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/))
//   {
//       var iplong = 0;
//       var power  = 1;
//       for(var i=4; i>=1; i-=1)
//       {
//           iplong += power * parseInt(components[i]);
//           power  *= 256;
//       }
//       return iplong;
//   }
//   else return -1;
// };

// THIS FUNCTION IS WRONG
// export const inSubNet = (ip, subnet) => {   
//   var mask, base_ip, long_ip = ip2long(ip);
//   if( (mask = subnet.match(/^(.*?)\/(\d{1,2})$/)) && ((base_ip=ip2long(mask[1])) >= 0) )
//   {
//       var freedom = Math.pow(2, 32 - parseInt(mask[2]));
//       return (long_ip > base_ip) && (long_ip < base_ip + freedom - 1);
//   }
//   else return false;
// }

export const IPnumber = (ip:IPAddress):number => {
//  var ip = IPaddress.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
//  if(ip) {
//      return (+ip[1]<<24) + (+ip[2]<<16) + (+ip[3]<<8) + (+ip[4]);
//  }
  return (+ip[1]<<24) + (+ip[2]<<16) + (+ip[3]<<8) + (+ip[4]);
}

export const isIPAddress = (str: string): str is IPAddress => {
  // return str.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/
  // const ipRegex = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/
  return ipRegex.test(str)
}

export const sameNet = (IP1:any, IP2:any, mask:any) => {
  //log(`${IPnumber(IP1) & IPnumber(mask)} == ${IPnumber(IP2) & IPnumber(mask)}`)
  // Check if the IP addresses are strings
  if (isIPAddress(IP1) && isIPAddress(IP2) && isNetmask(mask)) {
    return (IPnumber(IP1) & IPnumber(mask)) == (IPnumber(IP2) & IPnumber(mask))
  } else {
    return false
  }
}

export const findIp = async (address:IPAddress):Promise<IPAddress | undefined> => {
  // Use a shell command to resolve the ip address
  // REmove the trailing \n from the ip address
  try {
    const interfaceData = os.networkInterfaces()
    const ip = interfaceData["eth0"]?.find((iface) => iface.family === "IPv4")?.address
    if (ip && isIPAddress(ip)) {
      return ip
    } else {
      return undefined
    }
  } catch (e) {
    return undefined
  }
}

export const findIp2 = async (address:IPAddress):Promise<IPAddress | undefined> => {
  // Use a shell command to resolve the ip address
  // REmove the trailing \n from the ip address
  try {
    const ip = (await $`ping -c 1 ${address} | grep PING | awk '{print $3}' | tr -d '()'`).stdout.replace(/\n$/, '')
    if (isIPAddress(ip)) {
      return ip
    } else {
      return undefined
    }
  } catch (e) {
    return undefined
  }
}

export const reset = async ($) => {
  console.log(chalk.blue('Resetting the local engine'));
  try {
      // console.log(chalk.blue('Removing the yjs database'));
      // await $`rm -rf ../yjs-db`;
      // console.log(chalk.blue('Removing all appnet ids'))
      // if (config.settings.appnets) {
      //   config.settings.appnets.forEach((appnet) => delete appnet.id)
      //   console.log(chalk.blue('Updating the config file'));
      //   writeConfig(config, '../config.yaml')
      // }
  } catch (e) {   
      console.log(chalk.red('Failed to reset the local engine'));
      console.error(e);
      process.exit(1);
  }
}

export const prompt = (level:number, message: string) => {
  // Create level*4 spaces
  const spaces = ' '.repeat(level * 4)
  console.log(chalk.green(spaces+message))
  return question(chalk.bgMagentaBright(spaces+'Press ENTER when ready'))
}

// Generate a uuid
export const uuid = ():string => {
  const id = Math.random().toString(36).substring(2) + Date.now().toString(36)
  log(`Generated uuid: ${id}`)
  return id
}

export const uuidLight = ():string => {
  return uuid().substring(0, 8)
}


// A function to strip the trailing partition number from a device name
export const stripPartition = (device: string):string => {
  if (device.startsWith('nvme') || device.startsWith('mmcblk')) {
    return device.replace(/p[0-9]+$/, '')
  }
  return device.replace(/[0-9]+$/, '')
}
