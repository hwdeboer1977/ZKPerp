// The 'test_zkperp_amm' test program.
import zkperp_amm.aleo;
program test_zkperp_amm.aleo {
    @test
    @should_fail
    fn test_main_fails() {
        let result: u32 = zkperp_amm.aleo::main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    constructor() {}
}
