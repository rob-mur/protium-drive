@capability:mount
Feature: Mounting the Drive as a folder

  @id:the-mount-shows-drive-files-as-files
  Scenario: The mount shows the Drive's files as files
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user mounts the Drive at a folder
    When the user reads the mounted file "Photos/beach.jpg"
    Then the mounted file holds "sand and sea", and the mounted folder "Photos" holds exactly "beach.jpg"

  @id:a-file-written-through-the-mount-reaches-the-drive
  Scenario: A file written through the mount reaches the Drive
    Given a Drive whose My files holds the folder "Photos"
    And the user mounts the Drive at a folder
    When the user writes "sand and snow" to the mounted file "Photos/new.jpg"
    Then within 60 seconds the Drive holds "Photos/new.jpg" containing "sand and snow"

  @id:a-mount-starts-on-a-folder-a-killed-mount-left
  Scenario: A mount starts on a folder that a killed mount left behind
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the folder the user mounts the Drive at was left mounted by a mount that was killed
    And the user mounts the Drive at a folder
    When the user reads the mounted file "Photos/beach.jpg"
    Then the mounted file holds "sand and sea", and the mounted folder "Photos" holds exactly "beach.jpg"

  @id:a-mount-creates-its-folder-when-it-does-not-exist
  Scenario: A mount creates the folder it mounts at when the folder does not exist
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the folder the user mounts the Drive at does not exist
    And the user mounts the Drive at a folder
    When the user reads the mounted file "Photos/beach.jpg"
    Then the mounted file holds "sand and sea", and the mounted folder "Photos" holds exactly "beach.jpg"

  @id:a-mount-refuses-a-folder-that-holds-files
  Scenario: A mount refuses a folder that already holds files
    Given a Drive whose My files holds the folder "Photos"
    And the folder the user mounts the Drive at holds the file "notes.txt"
    When the user mounts the Drive at that folder
    Then the mount is refused with exit status 2 and a message that names the folder, and the folder still holds exactly "notes.txt"

  @id:a-write-a-killed-mount-left-reaches-the-drive-after-the-next-start
  Scenario: A write that a killed mount left behind reaches the Drive after the next start
    Given a Drive whose My files holds the folder "Photos"
    And the user mounts the Drive at a folder
    When the user writes "sand and snow" to the mounted file "Photos/new.jpg"
    And the mount and every process it started are killed before the write reaches the Drive
    And the user starts the mount again on the same port
    Then within 60 seconds the Drive holds "Photos/new.jpg" containing "sand and snow"

  @id:a-write-a-killed-mount-left-reaches-the-drive-after-a-start-on-another-port
  Scenario: A write that a killed mount left behind reaches the Drive after a start on another port
    Given a Drive whose My files holds the folder "Photos"
    And the user mounts the Drive at a folder
    When the user writes "sand and snow" to the mounted file "Photos/new.jpg"
    And the mount and every process it started are killed before the write reaches the Drive
    And the user starts the mount again on another port
    Then within 60 seconds the Drive holds "Photos/new.jpg" containing "sand and snow"

  @id:a-mount-stopped-with-a-write-pending-names-the-file
  Scenario: A mount stopped before a write reaches the Drive names the file in its log
    Given a Drive whose My files holds the folder "Photos"
    And the user mounts the Drive at a folder
    When the user writes "sand and snow" to the mounted file "Photos/new.jpg"
    And the mount is stopped before the write reaches the Drive
    Then the mount's log names "Photos/new.jpg" as not yet on the Drive

  @id:a-stopped-mount-unmounts-the-folder-and-exits-0
  Scenario: A mount stopped as a service manager stops it unmounts the folder and exits 0
    Given a Drive whose My files holds the folder "Photos"
    And the user mounts the Drive at a folder
    When the user starts the mount
    And the mount is stopped
    Then the mount exits 0 on its own, and the folder is no longer mounted
