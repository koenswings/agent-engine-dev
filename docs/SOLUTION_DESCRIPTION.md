# Solution Description

## Mission
*   Create an offline Web App Management System
*   A plug and play solution that is intuitive to use by non-tech-savy users and requires little maintenance
*   Using the most cost efficient client as well as server hardware as possible
*   And enabling shared use of the client hardware by its users (so avoiding the necessity to make everything personal if the budget does not allow for that)

## High-level Requirements and Visions
*   **Physical System Management**
    *   The system shall employ as much as possible a physical metaphor for carrying out IT management operations
        *   For example starting a Web App by docking a disk in a docking station instead of operating an admin application
    *   The idea behind this is that these operations are more intuitive and tangible than operating some admin console UI
*   **Smart Pro-Active Management**
    *   Instead of building a passive UI that just waits for some system admin to perform an operation, the system should pro-actively analyse the system and suggest management operations when they are needed
*   **Offline Remote Management**
    *   The system should support the capability to allow remote offline users to perform operations on the system without requiring a technical expert locally to perform these operations
*   **Web App Servers as appliances**
    *   We shall as much as possible implement the Web App Server as an appliance rather than as software to be installed on a general purpose computer
    *   And supply it as part of the solution
    *   Advantages
        *   Reduced complexity in the setup as it does not require a user to install software on a computer
        *   By dedicating a device to it and not installing it as software on an existing system, there is a minimal impact on existing infrastructure
*   **Realtime data**
    *   When data is displayed in the solution, that data shall be updated in real-time when it changes and the solution shall be built with the latest technologies on this front
    *   Examples
        *   When a new App gets docked, users get notified when the new App becomes available
        *   When an already opened App gets undocked, users get notified
        *   Users can see a list of available Apps and their status and that list is automatically kept up-to-date when Apps are docked or undocked
*   **The solution shall be built as a distributed system using the concept of CRDTs**
    *   All participants shall be considered as peers and not as clients to servers
    *   Instead of creating a message communication between peers, the systems co-operate by synchronising a shared data structure built using CRDTs that are guaranteed to converge to a single data set.
*   **Standardise as much as possible the hardware to ease maintenance**
*   **Shared client hardware**
    *   In order to reduce the cost of an installation, client hardware must be shareable across users
    *   Teachers must be able to time share the clients across different users or groups of users
    *   More specifically
        *   A user must be able to use any of the installed clients and use it as his own personal computer giving access to his own personal data
        *   A client must be usable for a group of users at the same time
            *   This allows a teacher to distribute a group of students over a smaller collection of computers

## High-Level Solution
*   The solution consists of two types of systems
    *   **Appdockers**
        *   Computers on which the Engine software of the solution is installed
        *   The Engine turns these computers into appliances on which you can plug and auto-execute disks or drives containing web apps which are immediately made available to all clients
    *   **Clients**
        *   Computers used by end-users on which the Console software of the solution is installed
*   The solution standardizes the hardware using the Raspberry Pi 5 of 500 for both the Appdockers as well as the Clients
    *   The Appdockers come in two configurations
        *   Assembled as a Docking Station
            *   To be put in some protected room as a permanent setup
            *   Adding either a 4-bay SSD docking station or a multi-port USB hub to easily dock multiple App Disks
        *   Assembled as a USB Gadget
            *   It can be attached to any computer with a USB-C connection and it will automatically power from that connection and execute any attached App Disks, making them available on the same network as that computer
            *   See [[Raspberry Pi USB Gadget]]
                *   If the Pi is connected to a laptop the apps are still available after a power cut
                    *   But it becomes a bit fragile: If the laptop is displaced, the connection can easily be broken
                *   This is a way to turn any existing computer into an Appdocker
            *   If we load the device with embedded SD cards or super tiny Samsung Fit 128GB+ flash sticks for the OS and the Apps, the whole Raspberry Pi device can be seen as an App Disk
            *   Any USB gadget can be turned into a Server by self-powering the Executor and connecting it to a router of the LAN via an Ethernet cable
    *   The setup of a dedicated Appdocker only requires the following two actions
        *   The creation of a boot disk for the device that uniquely identifies that device
        *   The assembly of a Raspberry Pi
            *   Which is relatively straighforward
            *   It is hardware / physical, not software / virtual.
    *   Two possible configurations for the Clients
        *   A Raspberry Pi 5 connected to a large TV screen
            *   To create a Client that can be shared amongst small groups of students
        *   A Rapsberry Pi 500 connected to a Pi Screen
            *   For a smaller setup with less cable jungle
    *   A R450 WiFi access point / extender from TPLink is used to create a local WiFi called `appnet` to which the Clients can connect
        *   This creates a kind of local Internet (the `appnet`) that only serves the Apps that are docked into the Appdockers
        *   Optionally, the WiFi extender can be put into extender mode so that it can put the Appdocker(s) on an external WiFi network, making all the Apps available on that network
        *   Optionally, a switch is used to connect the WiFi extender to more than one Appdocker
    *   Although in principle any OS can be used on the Clients as long as it supports a modern web browser, the solution standardizes on the use of the Ubuntu Operating System (OS)
*   Apps are installed on App Disks which are SSDs that contain all the data necessary to run the App in its own Docker containers
    *   An App Disk can contain one or more App Instances
    *   Besides App Disks, the solution also supports the use of
        *   Backup Disks to automate the backup of Apps
        *   Files Disks to create a network file system
        *   Upgrade Disks to execute management operations on the Engine or Console software
*   Physical System Management is done in the following ways
    *   A Web App (**App**) is physically represented by the SSD drive, USB disk or USB stick on which it is contained (**App Disk**)
    *   The catalog of Web Apps is determined by the set of App Disks one has in his position
    *   The collection of running Web Apps (**Apps**) is determined by the collection of App Disks that are plugged in (**docked**)
    *   Apps are auto-started when App Disks are docked
    *   Backups are auto-triggered by docking Backup Disks
    *   Network file systems are created when a Files Disk is docked
    *   Custom upgrade operations are auto-triggered when an Upgrade Disk is docked
*   Physical management of the performance of the system is done as follows
    *   The devices on which App Disks are docked are called **Appdockers**
    *   All Appdockers on the same LAN will automatically find one another and when a new Appdocker device is added, the catalog of available apps is automatically extended with the apps docked onto the new device
    *   Performance is optimized by adding Appdockers and redistributing the apps over the Appdockers
*   Smart pro-active management is done as follows
    *   The system proposes an upgrade of an Engine when a newer Engine is started in the network with an updated system software
    *   The system proposes an upgrade of an App when an App Disk is docked that has a newer version of the App
*   Physical management of the security of the system is done as follows
    *   The person who has access to the disk has the rights to run it or stop it
        *   So this is similar to the use of physical tokens in security
    *   The person who has access to the App Docker device has the right to assemble, disassemble, stop or start it
*   To allow users to use each of the installed Clients as his own personal computer, two solutions are employed
    *   By standardizing the hardware, we can give each user an SSD disk with his own personal copy of the Client OS. The user can insert this disk in any of the clients and boot the Client with that disk in order to turn the Client into his own personal computer
    *   By making the Nextcloud App part of the solution, and giving users their own personal account on Nextcloud, we allow users to log onto Nextcloud and get access to their personal data on any of the installed clients
*   The solution employs the latest developments in real-time conflict-free syncing of data across computers in a network to achieve realtime update of the availability of Apps on the network

## Components of the Solution
*   **Disks**
    *   These are `ext4`-formatted SSD drives that are dynamically inserted (**docked**) or removed (**undocked**) from free USB slots of the Appdocker devices
    *   All Disks have a `META.yaml` file with important data on the Disk
    *   The content of the Disk determines its type
        *   Although in practise we will create disks that serve a single purpose, the solution has been built to support disks with multiple purposes. So a single disk can be of multiple types.
    *   Types of Disks
        *   **Engine Disk**
            *   A Disk that contains the system software that turns a Raspberry Pi computer into an Appdocker appliance
            *   Once docked, an Engine Disk can become the source or a target of an Engine upgrade operation
                *   Engine upgrades are possible when an Engine Disk is docked that has a newer Engine version than another Engine that is already running on the network
                    *   To support this, the Engine Disk also contains the installers for the Engine
            *   Engine Disks are created by project admins, not end users
        *   **Client Disk**
            *   A Disk to be inserted into a Client device in order to boot that Client into a specific OS
                *   For example a disk that turns the Raspberry Pi into a ChromeOS or Linux Client
            *   The user must reboot the machine to start the disk
            *   Client Disks are created by project admins, not end users
        *   **Empty Disk**
            *   This is an `ext4` formatted disk
                *   [[TBD]] if it should contain a mark that it is to be used as an appdocker Disk
            *   When an Empty Disk is docked, the User can use the UI to
                *   Create a new App Instance
                    *   When a user wants to create an new App Instance, the instance can be taken from several sources
                        *   The system searches for available Apps on the network that can be instantiated
                            *   This can be docked App Disks
                            *   Or docked Backup Disks containing different versions of Apps
                            *   Or docked App Catalog Disks
                        *   When online, Apps can be instantiated from an online repository on Github
                *   Clone other Apps
                *   Turn it into a Backup Disk and configuring the Apps that need to be backed up to this Disk
                *   Turn it into a Files Disk and configure the Apps in which it is to be auto-mounted
            *   Empty Disks are created by project admins, not end users
        *   **Upgrade Disk**
            *   A disk that when inserted and when authenticated will execute a script that performs some upgrade operation on the current system
            *   See Create an upgrade disk
            *   Upgrade Disks are created by project admins, not end users
        *   **App Disk**
            *   Contains one or more Web Apps
                *   Technically, it contains an instance of an **App** called an **App Instance**
                    *   These are also the names for these entities in the code
                    *   In this document however we are sometimes a bit lousy with that terminology. When we want to be clear about the difference, we will use the terms **App Instance** and **App Master** explicitly
                *   We can have multiple App Instances of the same App in the system, each with its own data
                *   Each App is defined by a repository on Github. This repository contains the following data
                    *   A Docker compose file referencing one or more Service Images on Docker Hub
                    *   Metadata for the App
                        *   Information describing the App
                        *   Information describing the person who created the App repository
                        *   An own version nummer for the App
                    *   An optional init_data folder that contains initial data that is bind-mounted into the App
                *   Each App Instance inherits the same data but adds information like a unique instance ID
            *   On docking to an Appdocker
                *   The Engine software on the Appdocker device detects the Disk and reads its meta data to find out what kind of Disk it is
                *   If an App, a notification is sent to all users that the App has become available
                    *   The App becomes accessible everywhere on the same LAN as the Appdocker device onto which it is docked
                    *   So everybody has access and the App has to have its own authentication mechanism if access is to be further restricted
            *   Undocking causes the App to become unavailable
                *   The preferred way to undock an App is to eject it using the Console UI to which all users have access
                *   But an App can also be undocked by unplugging it from the Appdocker machine
            *   Examples
                *   A Nextcloud App Disk with pre-registered logins for all users on the network (eg students of a class pre-registered by a teacher)
                *   A Nextcloud App Disk with only one user account. That user can now use any Client on the network to access his files.
                *   A Wikipedia App Disk that gives all users on the network immediate access to the whole of Wikipedia without authentication
                *   An online video courses App Disk on which users can self-register and access educational videos
            *   Once docked, an App Disk can become the source or target for an upgrade operation
                *   App upgrades are possible when an App Disk is docked that has a newer version than another App Disk that is already running on the network
                *   An upgrade operation is only made possible if the newer version is a minor update, not an incompatible major upgrade that is incompatible with the data
            *   App Disks can be created by end users from Empty Disks using the Console (see When an Empty Disk is docked, the User can use the UI to )
        *   **Backup Disk**
            *   A disk containing backup archives for a preconfigured selection of Apps, or Files Disks (zero or more)
                *   Apps are identified by a unique instance ID
                    *   This ensures that we always backup the correct instance of the App
                        *   Eg if I take my backup disk from home and insert it on your network, this avoids that your nextcloud data will override my nextcloud data
                *   If a backup disk is configured for a specific App, we say that the backup disk is linked to that App
                *   An App can be linked to multiple backup disks
                    *   For example
                        *   One backup disk for daily backups, and another for weekly
                        *   One backup disk per classroom and another for the whole organisation
            *   The backups that are configured on the disk automatically start to run when the Disk is docked
                *   The backup disk contains a configuration file that determines when this will be done
                    *   Immediate
                        *   This causes the backup operation to start immediately
                        *   As a result, Apps will be stopped one by one when it is their turn in the backup sequence
                    *   Scheduled
                        *   This causes the backup operation to start on a configured schedule
                        *   Eg once every day at 04:00 am
                    *   On Demand
                        *   No backup action is taken or scheduled when the Disk is docked
                        *   Users have to manually trigger the backup in the Console
                        *   > This option is to be used for an App Catalog Disk
                *   So the person who inserts a backup disk must be aware that this operation might disrupt the running of the Apps
            *   Once inserted, the backup disk becomes accessible for the execution of restore operation initiated via the main UI
            *   Backup Disks can be created by end users from Empty Disks using the Console (see When an Empty Disk is docked, the User can use the UI to )
        *   **App Catalog Disk**
            *   This is a Disk that contains a collection of Apps, not for the purpose of running the Apps, but for serving as a source when users want to create a new App Disk or add a new App to an existing App Disk
                *   The Disk actually contains instances of specific versions of Apps, each with its own data
                *   So we can have two App Instances of the same version of an App but each with their own specific data
                    *   For example two instances of `Kolibri` version `1.1`, one with instructional videos on Science & Technology and the other one with instructional videos to learn English
            *   Nothing noticeable will happen when an App Catalog Disk is docked. But the system will remember its presence and the collection of Apps on it will be added to the collection of installable Apps that is presented to a user when he wants to create a new App Instance.
            *   > Implementation wise, an App Catalog Disk is actually just a regular Backup Disk that contains different instances of Apps and is configured for On Demand backup only.
                *   Since an App Catalog Disk is implemented as a Backup Disk, this means that an new App can also be created using a simple Restore operation initiated from the Console UI
            *   Just as Backup Disks, App Catalog Disks can be created by end users from Empty Disks using the Console (see When an Empty Disk is docked, the User can use the UI to )
        *   **Files Disk**
            *   Contains a File System that is automatically network mounted when docked
            *   The creator of the Files Disk decides whether or not to protect the content with a password
            *   Files Disks are also auto-mounted into Apps that have been created with the ability to work with Files Disks
                *   The Files Disk is then mounted into a preconfigured mount point of the App
                *   Examples
                    *   A file store into Nextcloud
            *   Files Disks can be created by end users from Empty Disks using the Console (see When an Empty Disk is docked, the User can use the UI to )
*   **Console**
    *   The software that gets installed on every Client that gives users access to the Apps and allows them to manage the system
    *   Maintained in this repository on Github
    *   It is a Web Application Implemented as a Chrome Extension
    *   Tasks and conceptual UI design
        *   The Engines on the networks and their Disks (Left Pane)
        *   The Apps on each Disk (Right Pane)
        *   An All Apps option in the Left Pane allows to show all Apps on the Network
            *   Could be a common parent called "Network"
        *   For each Engine
            *   An option to upgrade the Engine if a newer Engine is found on the network
        *   For each Disk
            *   A control to stop all Apps on the drive and eject the drive
            *   An option to add a new App instance to the Disk
                *   The collection of available Apps that can be instantiated is determined as follows
                    *   Apps that are docked on the current network
                    *   Apps that are on a docked Backup Disk or App Catalog Disk
                        *   If different versions are found, the user must select which version to use
                        *   > This is how we do a Restore operation on the platform. So there is no explicit Restore operation (at least not in the UI). We just add an App from a backup source
                    *   Apps on the Github repo of the project if the Engine has an Internet connection
                *   Irrespective of where the App comes from, the new App that is created must have a new unique Instance ID since we are creating a new instance
        *   For each App
            *   Clicking an App opens it
            *   Whether the App is running or not, its health
                *   This could be a single bullet with a green (running), yelow (stopped) or red color (in error)
                *   Clicking on this control opens the metrics for this app
                    *   Uptime
                    *   When it was last backed up
                    *   When it was created
                    *   Docker metrics
                        *   %CPU
                        *   MEM USAGE / LIMIT
                        *   MEM %
                        *   NET I/O
                        *   DISK I/O
            *   Controls to start/stop Apps
            *   An option to upgrade an App if a newer version is found on the network
            *   An option to manually trigger a backup of the App if a backup disk is found on the network
                *   If the App was already linked to the found Backup Disk, and only one linked Backup Disk was found, the backup operation starts immediately irrespective of the schedule that was defined for it on the backup disk
                *   If that App is not already linked to a backup disk, or if multiple linked backup disks are inserted (for example one for daily backups and one for weekly backups), the user must select the backup disk to be used and the backup operation starts immediately irrespective of the schedule that was defined for it on the backup disk
                    *   A link is made for that App if no link was configured so that the next time the backup disk is inserted, the App is automatically backed up
        *   Drag and Drop operations to
            *   Copy Apps from one Disk to another
                *   The copied App must receive a new instance ID
            *   Move Apps from one Disk to another
                *   The moved App must have the same instance ID
                *   This is to ensure it keeps backing up to its backup disk
            *   Backup an app on a backup disk
            *   Restore an app from a backup disk
*   **Engine**
    *   Engine is the software that gets installed on the Appdocker device
    *   Engine code is executed in two possible ways
        *   A NodeJS-based runtime that runs natively on the Appdocker as a background process managed by [[pm2]]
        *   A set of NodeJS scripts that give the Engine administrator a CLI towards some of the functions of Engine
    *   Runtime
        *   The runtime is basically a background process that implements a set of monitors that trigger Engine functionality based on some specific event
        *   There are monitors for detecting
            *   Disk docking and undocking
            *   The presence of a new Engine on the network the Engine is connected to
            *   An incoming connection request from a remote Console or Engine for performing data sync operations
            *   The passage of certain amount of time
            *   Any changes to the network database such as
                *   The change in status of one of the App Instances
                *   The addition of a Command to be executed on one of the Engines
    *   Scripts
        *   Some functionality of Engine is triggered from the command-line
        *   This functionality is implemented in Scripts
        *   Scripts allow an Engine Admin to open a Terminal on an Appdocker and execute functions such as building a Disk
    *   Engine also uses the following components
        *   Docker
        *   `ssh`
            *   For performing remote operations on another Engine
        *   `rsync`
            *   For all copy operations (for example copying of an App from one Disk to another)

## Network Architecture
*   **Apps**
    *   All apps are accessed using a port number on the `.local` domain name of the Appdocker
    *   Each App is started inside a Docker container
    *   The default network mode is `bridge`
        *   The entry points (default port numbers on which the App listens) are port-mapped to a unique port number
        *   This port mapping is done when the Engine `starts` the App
        *   Engine will try to find an available port on the network as it starts
        *   If an available port is found, it is stored on the App Disk so that it is re-used the next time the App starts. But this reuse can not be guaranteed: if between starts the port number becomes unavailable on the network, a new port number will be generated
        *   `bridge` mode is the preferred mode as it makes the App more isolated from the host and it also allows for an App Disk to contain multiple App Instances of the same App
    *   For some apps, the network mode is `host`
        *   This is only done when we are unable to portmap all entry points of the App
            *   For example, the Kolibri App uses dedicated port numbers for running interactive content and we could only make these port numbers available by running the App in network mode `host`
        *   Apps that are started in network mode `host` can only be instantiated one time per App Disk
    *   All Apps are currently accessed using `http` only
        *   But for some use cases, `https` is required
            *   Some Apps might refuse to start if not accessed via https
                *   Eg password managers
            *   When the insecurity of unencrypted communication on the local WiFi is a concern
        *   If in the future we decide to use `https`, the following analyses might be of interest
            *   Revisiting Certificates
            *   How to set up https
*   **Data Syncing**
    *   Onboarding
        *   Appdockers are given standardized names
            *   Using `appdocker` as a prefix
            *   And a sequence number as a postfix
        *   When a user starts the Console App for the first time, it will scan 10 seconds in the foreground for `appdocker01.local` ... `appdocker10.local`
            *   So start 10 threads in the background and return the response or lack of response in 10 seconds
        *   After that it will continue the scan in the background, but ask the user to type the name of an appdocker machine
        *   > In an initial phase of the project, a simplified solution will be used in which the name of the appdocker will be asked from the user when the Console is opened for the first time
    *   Normal Operation
        *   The names of these machines are kept in memory
        *   The scan is repeated in the background every x seconds
        *   In the settings menu of the Console app is an option to show and extend the list of appdockers
    *   Data Syncing
        *   Every Console opens a Websocket connection to just 1 of the found appdockers
        *   These appdockers use DNS-SD to find one another and connect to one another using Websockets
            *   We must avoid that these appdockers connect to one another mutually, creating double onnections
        *   So the appdocker that the console connects to acts as a kind of relay
            *   Its state updates are first propagated to the appdocker it is connected to
            *   Which then updates the states on all other appdockers
        *   Because there are no direct connections to an Engine from the Console, there is a delay to get messages to an appdocker to which the console is not directly connected
        *   All Engines are directly connected to one another and in the absence of Clients, they will keep one another updated
        *   Diagram
            *   {{iframe: https://viewer.diagrams.net/?tags=%7B%7D&highlight=0000ff&edit=_blank&layers=1&nav=1&title=Network%20Architecture%20A.drawio#R3Vjfd5owFP5rfHTHEPDH46q03dads821W%2FuWAxHiIqEhKOyvXzDBgKjtqW3FvXi4X3LJzf3udxPpwPEiu%2BIoDr8yH9OO1fOzDpx0LGsAHflbALkCnIGtgIATX0HAAFPyF2uwp9GU%2BDipTRSMUUHiOuixKMKeqGGIc7aqT5sxWl81RgFuAFMP0Sb6i%2FgiVOjQGhj8GpMgLFcG%2FZEaWaByst5JEiKfrSoQdDtwzBkT6mmRjTEtclfmRfld7hndBMZxJJ7jcDX6FDn9u%2F74ZjD%2Ffh3%2FmT%2Fm8y6AOjiRlzvGvkyANhkXIQtYhKhr0Asv5UtcvBVIg7M08tdWT1rG4YaxWE%2BZYyFyTS1KBZNQKBZUj%2BKMiN%2BF%2BwdHW%2FeVkUmm37w28tKIBM8rToV5Xx0zbmur9FObLXa4N4kaSljKPT3LfQCTR797545%2BfLnls4fPHPzslsWIeIDFgQzDDdVSIpgtsIxH%2BnFMkSDLehxIF2uwmWf4lA%2Ba0t30HgpyiWiqVxo3%2BF6FROBpjNa7XUkR1%2BlBSax0NSNZQfPF3pQtMRc4q0DNXetRq6c1oZsC6Gt7ZSRmayisqKvEjsnTbhnYZymDl5Xz7gwcWaba9RsjcmVDtFUn2hpuMajko722SNyEcQSvb1b%2FjWLfkfa99Q%2BtttW%2Fc5b1%2F77HwM7MWc88Bpx3OgYOBdk2Gdh222TQb40MQEUERhJPyaAmAqOJPTJIZNWKj8UlWQIeRUlCvBK%2BJLQM6RXVAs9BLWDQmip4WTP8X6rAPmUVwEbPdNvQM7evztYQnLZn2u3M0%2FYVy%2B6d%2BmwZnndXAW3vKs45dBWnnWrZvom9YVeRpvnmpf7nmQ%2BH0P0H}}

## Users and Operations
*   **Maintainer**
    *   Reviews and accepts proposed pull requests provided by Contributors
    *   Reviews and coordinates Issues submitted by Contributors
    *   Maintains and extends all code
    *   All done using Github
*   **Contributors**
    *   They submit issues
    *   They submit pull requests containing fixes
    *   They use Github to do this
    *   We make a distinction between Code Contributors and App Contributors
        *   App Contributors extend the platform by creating additional Apps and Services
        *   Code Contributors are programmers that work on the Console or Engine code
*   **Engine Admin**
    *   Responsible for deploying the solution
        *   Assembling appdocker devices for an end-user organisation
        *   Creating as needed the Engine Disks, Clients Disks, Upgrade Disks and Empty Disks for the end-user organisation
        *   Creating the initial App Disks, File Disks, Backup Disks and AppCatalog Disks from the latest repo versions
            *   So the Engine Admin is someone who supplies the App Disks to an offline community so that they can start using and maintaining these Apps
            *   This also involves
                *   Creating different versions of an App, each preloaded with different data sets
                *   Creating backup disks specifically for the purpose of having a catalog of Apps that even contain different versions of an App with different data sets. This allows Console Admins to simply use Restore operations for creating App Disks.
*   **Console Admin**
    *   Responsible for managing the Disks
        *   Creating Apps and App Disks
        *   Copying or moving Apps
        *   Creating Backup Disks and a backup procedure for the Apps
        *   On demand restoring of Apps from Backup Disks if needed
        *   Creating Files Disks
        *   Upgrading Apps
        *   Upgrading Engines
    *   > In an initial version of the solution, we might not want to make the distinction between a Console Admin and an End User
*   **Console End User**
    *   Operates the Console to find and start Apps
    *   Starts locally attached App Disks when the Engine is installed
    *   Triggers automatic backups by inserting a Backup Disk

## Detailed Design
*   **Data Syncing**
    *   To enable real-time data exchange between Engines and between Engines and Consoles, we use a [[CRDT]]
        *   This means we create a Network Database that is synchronised across all Engines and by implementing this database according to the principles of the [[CRDT]] paradigm, we know that the syncing process is eventually consistent without and conflicts.
        *   For a list of alternative libs that we implemented, see SOLVED Which CRDT?
        *   The current implementation is based on [[Automerge]]
        *   In the past we used [[Yjs]]. But due to ongoing difficulties with [[Yjs]] and the lack of proper documentation migrated to `automerge` instead
            *   Yjs does not specify the `get` call to retrieve data from an object: is it asynchronous? And if yes, when in the whole syncing sequence is the data available?
            *   It was not clear how to add persistence to the data structure so that the identity of an Engine can be retained across Engine boots
    *   In order to propagate data updates and keep the complete application reactive, we heavily make use of [[Reactive State]] in both Engine and Console
        *   In the past when using [[Yjs]] this was done using [[Valtio]]
        *   Currently with [[Automerge]], we carefully refactored the code to perform all updates as granularly as possible and to implement them as part of a `storeHandle.change` callback. We then use implement all reactive behaviour into one callback (the `storeMonitor`) that handles all granular updates to the data.
    *   Websockets are used for the connection of Console to Engine and Engine to Engine
        *   For a list of alternative connection methods see SOLVED Network Architecture
            *   When using [[Yjs]], we were specially interesting in the use of `y-libp2p` which would enable the full force of `libp2p` to enable syncing across the Web
            *   This might be an interesting option for the future!!
            *   But technical difficulties forced us to use the much simpler approach of websockets
    *   Data Model
        *   We use a flat structure in which objects are kept in collections
        *   One-to-many relations are implemented using an `id` on the many part of the relation
*   **Engine**
    *   **Run architecture**
        *   The Engine Runtime runs as a [[pm2]] service
        *   [[TBD]] Find the issue that changed it from running as a Docker container
    *   **[[TBD]] Boot behaviour**
        *   See **^^Summary of start^^**
        *   See SOLVED Problem - When analysing the bootscript, we see that at boot a `startdev.sh` script is started - This has been created for the pm2 edition. However, pm2 is configured to autostart!
    *   Data Model
        *   See Refactoring the Store
    *   Monitors
        *   USB Device Monitor
            *   The monitor is started as part of the startup procedure and performs the following functions
                *   Cleaning up disks from the network database
                    *   If there are other engines on the network, they might sync the data of the previous instance of this engine!
                    *   So we might know from them the disks that were mounted before the reboot of the engine
                    *   If we find out that these previous disks are no longer mounted, we remove these disk objects from the network database
                *   Cleaning up devices
                    *   We remove the folders on the mount point /disks if they are no longer connected to actual devices on /dev/engine
                    *   But to protect against race conditions, in which a disk is mounted just after we check if it is mounted, we use the following procedure
                        *   We move the content to /disks/old/${device}
                        *   This makes it unavailable on /disks/${device}
                        *   Which will cause errors during the processing of the disk
                *   Detecting Disk docking and undocking events which triggers Disk-specific behavior
                    *   Starting and stopping of Apps
                    *   Starting of backups
                    *   Starting of upgrade procedure
                    *   Mounting or unmounting of a networked file system
        *   mDNS Monitor
            *   For monitoring the addition or removal of other Engines on the same network.
        *   Commands Monitor
            *   Listens to commands coming from a Console or from the Console CLI script
            *   See Commands
        *   Store Monitor
            *   For detecting and responding to granular updates of the data structure such as the addition of new Engines or Instances, the change in status of an Instance, the addition of a Command to be executed on an Engine, ...
    *   Commands
        *   Commands
            *   Commands are always targeted to a specific Engine
            *   They are put in a list of the Network Database before execution and removed from the list after execution
            *   If after a reboot, an engine still finds commands in its command list, it will retry the command
            *   To avoid any duplication, we made all commands idempotent, which means they can be executed as many times as required without changing the results
            *   See On commands
            *   See Begin met de transfer van commands naar scripts
            *
        *   The following commands are available
            *   ls, lsEngines, lsDisks, lsApps, lsInstances
            *   Start / stop Apps
                *   createInstance, startInstance, runInstance, stopInstance
            *   Eject Disks
            *   Initiate an App copy process and report progress
            *   Initiate an App move process and report progress
            *   Initiate an App backup process and report progress
            *   Initiate an App restore processes and report progress
            *   Initiate an App upgrade process and report progress
            *   Initiate an Engine upgrade process and report progress
    *   Engine Identity
        *   Engines have a unique id for the following reasons
            *   If we take backups to a shared backup disk, to distinguish one Engine from another
            *   To generate a unique Zerotier id if we decide to use Zerotier in the future
            *   To generate a unique ssh key
            *   To distinguish this Engine from another one in t
        *   In our project, identity is hard-linked with the Disk
            *   Two Engines on two Disks are two seperate entities even if they are clones of one another because a user can decide to boot from either of them and start making them differently
            *   So therefore we can not store the identity as content on a Disk and we have to use an identity that is derived from the underlying hardware of the disk.
        *   We use the hardware id if the SSD on which the Engine code is installed as the id of the Engine
        *   When the Engine Disk is cloned, a new id is generated for the clone Disk on its first boot and this will also re-initialise any identity-related features
    *   Implementation of Docking
        *   We use [[udev]] rules in Linux in order to create symlinks in the `/dev/engine` directory to `sd?2` devices whenever a new device is added or removed
            *   See Using udev rules
        *   The Nodejs library `chokidar` is used to monitor the `/dev/engine` directory and trigger callbacks in Engine when a link is added or unlinked
    *   Detecting other Engines
        *   We use mDNS Advertisement and Discovery for detecting other Engines on the same LAN
        *   Two libraries are used for that
            *   `ciao` for advertising the engine service on the networks the Engine is atached to
            *   `node-dns-sd` for service discovery
        *   For a more detailed analysis see
            *   mDNS Advertisement and Discovery
            *   [[mDNS libraries for Nodejs]]
    *   Remote file copy
        *   Remote file copy operations are performed to copy an App from an App Disk on one Engine to another App Disk on another Engine
        *   `rsync` is used to perform these copy operations
            *   `rsync` is the choice by excellence for this because
                *   It can compress before copying and it will first diff the source and destination so that it only copies what is needed
                *   It can be interrupted and will diff the source and the destination before starting again
            *   Outstanding rsync operations are listed in the database so that they can be observed and managed by each Consoles
            *   `rsync` requires `rsync` client to be installed on the source Engine and `ssh` to be installed on the target Engine
            *   See
                *   `rsync` command options
                *   Using rsync
                *   **Test host to host rsync via test containers**
    *   Backups
        *   Backups are performed using [[BorgBackup]]
    *   Scripts
        *   All scripts are implemented using [[zx]]
            *   See zx in Which script language do we use
        *   There are currently 5 scripts that are run from the command-line
            *   The `build-service` script
                *   Executed by an Engine Admin on a computer where Engine is installed
                *   To build a Service Image from the `service<service name>` repository and push it with the appropriate tag on Docker Hub
            *   The `build-app-instance` script
                *   Executed by an Engine Admin on a computer where Engine is installed
                *   To instantiate an App on a locally attached Disk
                    *   We only require the Disk to have a `META.yaml` file.
                    *   The required folder structure to turn it into an App Disk is automatically created if it was not yet present
            *   The `build-image` script
                *   Executed by an Engine Admin on a computer where Engine is installed
                *   To turn a remote Raspberry Pi with a freshly downloaded Raspbian OS into an Engine, hence turning the system disk of that Pi into an Engine Disk
            *   The `sync-engine` script
                *   To sync Engine code from a development system to a running Engine
            *   The `console-cli` script that implements a simple command-driven Console
                *   Executed by a Maintainer or Code Contributor
                *   This is mainly used for diagnostics and for testing the commands that are sent from a Console (see Commands Monitor)
                *   See [[Writing a commandline interpreter using AI]]
                *
*   **Console**
    *   This is still work in progress. The current implementation does not yet feature a Console
        *   Instead, the Console UI is implemented as web page served by each Egnine.
        *   So this is a lightweight solution in which the end-user opens a page on the Engine using its domain name. This page is a simple HTML page that displays the list of available Apps. It is real-time updated whenever Apps are added or removed and the browser performs a scheduled refresh to display the updates to the user.
        *   It is a bit a variation of the following solution: A simple no-Yjs solution for the Console and the communication with and between the Engines
    *   In the future, the Console will be built as a [[Chrome Extensions]] using the [[Svelte]] reactive framework
        *   Here is the list of Reactive frameworks we considered
            *   SOLVED We need a fully reactive UI framework
        *   Why extensions
            *   **Main advantage of Chrome Extension is that it is integrated into Chrome which is also where the apps will run**
            *   If we build it as a PWA, the user clicks an App and this then opens their browser
                *   So it is not integrated in one Application
            *   If we build it as a regular web app, we need a web server...
                *   We could run it from an Engine
                *   But then the user has to typ the address in the address bar
                *   With an extension, we can offer a UI to bootstrap the search for an Engine
            *   Relevant Examples
                *   cookbook.sidepanel-open
                    *   Opens a main page with a side panel
                    *   The side panel remains on every other page
                *   sample.co2meter
                    *   Starts with a popup
                    *   Popup has a button that displays a page
                    *   Similar examples
                        *   sample.dnr-rule-manager
                *   tutorial.websockets
                *   Merlin
                    *   When you click it, it opens a page directly
                    *   So popups are not required
                    *
            *   Which features of Web Extensions are we interested in?
                *   Just opening the App in a new browser page
                *   Maybe
                    *   Combining a Popup with a main page
                    *   A Sidepanel that is persistently showing all apps that a user can open
            *   Which APIs do we want to use
                *   Send system tray notifications with the `chrome.notifications` API
                    *   https://developer.chrome.com/docs/extensions/reference/notifications/
                    *   Works on any OS, some limitations on Mac
                        *   Button icons not visible for Mac OS X users.
                    *   Allows to create rich notifications using templates and show these notifications to users in the system tray at the bottom right
                    *   !
                *   Detect disk insert and ejects using the `chrome.system.storage` API
                    *   https://developer.chrome.com/docs/extensions/reference/system_storage/
                    *   Works on any OS
                    *   Allows to be notified when a removable storage device is attached and detached
                *   Modify requests using `chrome.declarativeNetRequest` to allow users to just type in the name of an app in the address bar to open it
                *   Which APIs might be useful
                    *   Show system info using `chrome.system.memory` and `chrome.system.cpu`
                        *   https://developer.chrome.com/docs/extensions/reference/system_memory/
                        *   https://developer.chrome.com/docs/extensions/reference/system_cpu/
                        *   Works on any OS
                        *   Monitor CPU usage and temperature, and Memory !
                    *   Manage the power using `chrome.power`
                        *   https://developer.chrome.com/docs/extensions/reference/power/
                        *   Works on any OS
                    *   Use the chrome.enterprise.platformKeys API to generate keys and install certificates for these keys.
                        *   The certificates will be managed by the platform and can be used for TLS authentication, network access or by other extension through chrome.platformKeys.
                        *   https://developer.chrome.com/docs/extensions/reference/enterprise_platformKeys/
                        *   Works only on ChromeOS !
                    *   Exchange messages with native Apps using native messaging
                        *   https://developer.chrome.com/docs/extensions/mv3/nativeMessaging/
                        *   Works on any OS
                    *   Get a unique app id
                    *   Make it easier for the user to find Apps using `chrome.omnibox`
                        *   https://developer.chrome.com/docs/extensions/reference/omnibox/
                        *   Works on any OS
                        *   Register a keyword with Google Chrome's address bar, which is also known as the omnibox.
                        *   When the user enters your extension's keyword, the user starts interacting solely with your extension. Each keystroke is sent to your extension, and you can provide suggestions in response.
                *   Which APIs are TBD if useful
                    *   Detect changes in the idle state and login state
                    *   `chrome.fileSystemProvider`
                        *   https://developer.chrome.com/docs/extensions/reference/fileSystemProvider/
                        *   Allows you to create a virtual file system that is shown in the Files App
                        *   ChromeOS only
                    *   `chrome.alarms`
                        *   https://developer.chrome.com/docs/extensions/reference/alarms/
                        *   Program a timer with a callback
                        *
        *   Which Svelte Component Lib
            *   Requirements
                *   Drag and Drop
                *   Tree or Nested List
            *   Evaluation
                *   Skeleton limited
                *   SMUI has trees and drag and drop
                *   Smelte has nested lists
        *   We use the `internal-ip` library to detect the IP address of the host in the browser
            *   See https://stackoverflow.com/questions/20194722/can-you-get-a-users-local-lan-ip-address-via-javascript
            *   Note sure if this is still needed
*   **Disks**
    *   All Disks are formatted with the `ext4` file system
        *   It is the default journaled file system on Linux (the OS on which the Engine software is installed)
        *   We need a journaled file system because we want to allow end users to stop Apps by undocking them from the Appdocker. Since a journaled file system writes changes before committing them, any write operation that is interrupted can be rolled back when the file system is mounted the next time
            *   See https://www.quora.com/What-is-journalling-in-file-system
    *   All Disks except for Clients Disks have a `META.yaml` file in the root location
        *   This file indicates that it is a Disk created for this project
        *   It contains important metadata about the disk such as
            *   A unique disk id
            *   A user-defined disk name, not necessarily unique
            *   A timestamp indicating when the disk was created
            *   A timestamp when the disk was last docked or booted (in case of an Engine Disk)
            *   The version of Engine in case of an Engine Disk
        *   To guarantee the uniqueness of Disks after a clone operation, the disk id is read from a hardware id on the disk device itself and written to the `META.yaml` file after each docking or boot operation
            *   In case of an Engine Disk, this also triggers a re-personalisation of the Disk
                *   For example to update cryptographic keys
            *   > Some disks do not have a unique hardware id or we are not able to read it from them. In that case, the script that creates the disk generates a unique id. **However, that means that the disk is no longer unique anymore after a cloning operation since the cloned disk will continue using the same generated if.**
                *   In the future we might decide that it is better for the system to refuse the creation of Disks that do not have a unique hardware id
        *   It has the following data structure
            *   ```javascript
                diskId: DiskID
                // The serial number of the disk or user-assigned iif there is no serial number - We store it so that it easily inspectable

                isHardwareId?: boolean
                // True if the diskId is a hardware id, false if it is a user-assigned id. If this is not present, the diskId has a generated id.

                diskName: DiskName
                // The user-defined name of the disk.  Not necessarily unique

                created: Timestamp
                // The timestamp when the disk was created

                version?: Version
                // Only applicable to Engine Disks - the version of the engine running on the disk

                lastDocked: Timestamp
                // The timestamp when the disk was last docked (for all disks except OS disks) or when the engine was last booted (in case of a system disk)
                ```
        *   For more details see
            *   **^^Revisiting Disk Identity^^**
            *
    *   **Engine Disks**
    *   **App Disks**
        *   App Disks are disks containing the following directories
            *   `apps`
                *   The folder that contains the master data of one or more Apps
                *   Each App is in its own folder with the name `<app name>-<app version>`
                *   Each App folder contains the master data for a specific version of the App
                    *   It is an exact copy of the master data in the `app-<app name>` repository of the project
                    *   The following data is present
                        *   The `compose.yaml` file to start the App
                        *   An optional `init_data.tar.gz` file containing any initial data for the app that is to be bind-mounted into the App on first start
                            *   For example any initial courses for the Kolibri App
                    *   A thumbnail image for the App referenced in the `x-app` section of the compose file
            *   `instances`
                *   The folder that contains the instance data of one or more App Instances
                *   Each App is in its own folder with the name `<app name>-<instance id>` where instance id is a unique id generated when the App Instance is created
                *   The App Instance folder contains the data from the master, with the following changes or additions
                    *   The `x-app` metadata in the compose file is extended with the following data
                        *   A user-friendly instance name that is supplied by the user creating the instance. It does not necessarily have to be unique. Its sole purpose is to make the instance easier identifiable for the users of the system
                        *   The version string of the App Master. This is added because the version of an App is not stored in the master compose file
                            *   It might be a bit cleaner to store the version info in a separate file and not in the compose file
                    *   A `.env` file that stores the port numbers and passwords referenced in the compose file
            *   `services`
                *   This folder contains the service images of all services used by all Apps stored on the App Disk
                *   They are stored on the Disk itself so that no Internet access is required to download them from Docker Hub
        *   App Disks are created by the App Maintainers using the `build-service` and `build-app-instance` scripts
            *   As a first step, the App Maintainer creates the necessary Service Images on Docker Hub using the `build-service` scripts
                *   Since we want to keep our options open to run Engine on other hardware than Raspberry Pi, or to build the Service Images on other machines than the Raspberry Pi, we create multi-platform images using the `buildx` tool of Docker
                    *   See We are creating multi-platform Images
            *   He then uses the `build-app-instance` script to create an instance on a Disk
            *   See the [[Powerberries Operations Guide]] for more info on the procedure to follow
        *   Unique IDs
            *   Each App instance on an App Disk has a globally unique ID because we must uniquely reference them when taking backups
        *   In the future, we might want to step away from the concept of an App and only talk about instances
            *   Instantiating an App Master is nothing else then cloning another App Instance
            *   Also the App on Github is an Instance but
                *   It has its version number coded as part of a tag and not inside the compose file
                *   It always has the App name as an instance name
                *   It has no .env but that is not an issue: we can delete that from any Instance and let the system on boot give it a port number
    *   **Empty Disks**
    *   **Backup Disks**
    *   **Files Disk**
        *   Each Files Disk as a whole, must have unique ID because we must uniquely reference them when taking backups
*   **Apps**
    *   Nextcloud
        *   Some Nextcloud specific configurations are implemented as part of the Engine code
        *   See [[Powerberries NextCloud App]]
