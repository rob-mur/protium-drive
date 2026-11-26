@capability:walk-read
Feature: Reading a file while an indexer walks the mount

  A file indexer walks every folder of the mount and reads every entry's attributes. Each file it
  meets for the first time costs the serve a node-key unlock, which for a key rclone 1.75.0 locked
  with Argon2 is about 0.4 s of CPU. A program that reads a file meanwhile, as a thumbnailer does,
  must not wait behind those unlocks.

  @id:a-read-during-a-walk-of-argon2-locked-files-starts-within-seconds
  Scenario: A file read while an indexer walks 160 Argon2-locked files gives its first byte within 5 seconds
    Given a Drive whose My files holds the folders "Archive/2021" to "Archive/2024" of 40 files each, every file with an Argon2-locked node key
    And the Drive's My files holds the 4 MiB file "Photos/beach.jpg" with an Argon2-locked node key
    And the Drive unlocks node keys and decrypts downloads for real
    And the user mounts the Drive at a folder
    When the user lists the mounted folder "Photos"
    And an indexer walks the mounted folder "Archive", and once the Drive has been asked for 30 of the walked nodes the user reads the first 64 KiB of the mounted file "Photos/beach.jpg"
    Then the read gives the file's first 64 KiB, its first byte comes within 5 seconds, and the walk was still running when it ended
